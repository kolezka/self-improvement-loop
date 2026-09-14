"""Thin HTTP shell over sil.ops. No business logic lives here: every route is
generated from the ops registry, and every mutation is a named op validated by
that op's pydantic model."""

from __future__ import annotations

import json
import logging
import secrets
import subprocess
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles

from sil import ops
from sil.config import ConfigError

STATIC_DIR = Path(__file__).resolve().parent / "static"
LOCAL_HEADER = "X-SIL-Local"
TOKEN_HEADER = "X-SIL-Token"

_LOGGER = logging.getLogger("sil.web")


def op_path(name: str) -> str:
    """`review.queue` -> `/api/review/queue`. One mapping, used by routes and tests."""
    return "/api/" + name.replace(".", "/")


def _configure_file_logging() -> None:
    from sil import paths

    log_path = paths.log_file("web")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    target = str(log_path)
    if any(isinstance(h, logging.FileHandler) and h.baseFilename == target for h in _LOGGER.handlers):
        return
    handler = logging.FileHandler(log_path)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    _LOGGER.addHandler(handler)
    _LOGGER.setLevel(logging.INFO)


def _allowed_hosts(port: int) -> set[str]:
    import os

    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    for extra in os.environ.get("SIL_WEB_ALLOWED_HOSTS", "").split(","):
        extra = extra.strip()
        if extra:
            hosts.add(extra)
    return hosts


def _invoke_op(name: str, payload: dict) -> Any:
    # sil.providers is owned by another group and may not exist yet at import
    # time; fall back to exception classes nothing ever raises so the except
    # clauses below stay well-formed either way.
    try:
        from sil.providers import ProviderError, ProviderTimeout
    except ImportError:
        class ProviderTimeout(Exception):
            pass

        class ProviderError(Exception):
            pass

    try:
        return ops.invoke(name, payload)
    except ConfigError as e:
        raise HTTPException(503, str(e)) from e
    except ProviderTimeout as e:
        raise HTTPException(504, str(e)) from e
    except ProviderError as e:
        raise HTTPException(502, str(e)) from e
    except ValueError as e:
        # Covers pydantic's ValidationError too: it subclasses ValueError.
        raise HTTPException(400, str(e)) from e
    except subprocess.CalledProcessError as e:
        stderr = e.stderr
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        raise HTTPException(502, (stderr or str(e))[-2000:]) from e
    except HTTPException:
        raise
    except Exception as e:
        _LOGGER.exception("unhandled error in op %s", name)
        raise HTTPException(500, type(e).__name__) from e


def create_app(token: str | None) -> FastAPI:
    """`token=None` runs tokenless: X-SIL-Local is then the sole guard.

    `app.state.port` starts at 0 (matches nothing) and must be set by the
    caller (see `serve()`) before requests are accepted.
    """
    _configure_file_logging()
    app = FastAPI(title="sil web", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.port = 0

    def guard(request: Request) -> None:
        host = request.headers.get("host", "")
        if host not in _allowed_hosts(app.state.port):
            raise HTTPException(403, "bad Host header")
        if request.headers.get(LOCAL_HEADER) != "1":
            raise HTTPException(401, f"missing {LOCAL_HEADER}: 1")
        if token is not None:
            supplied = request.headers.get(TOKEN_HEADER, "")
            if not secrets.compare_digest(supplied, token):
                raise HTTPException(401, f"bad or missing {TOKEN_HEADER}")

    # Op name is captured in a closure, never a default argument: a default
    # argument becomes a caller-overridable parameter FastAPI would happily
    # bind from the query string, letting a GET route dispatch a different op.
    def _make_get(name: str) -> Callable:
        def handler(request: Request, _: None = Depends(guard)):
            return _invoke_op(name, dict(request.query_params))
        return handler

    def _make_post(name: str) -> Callable:
        async def handler(request: Request, _: None = Depends(guard)):
            raw = await request.body()
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                raise HTTPException(400, f"invalid JSON body: {e}") from e
            return _invoke_op(name, payload)
        return handler

    for name, op in ops.REGISTRY.items():
        path = op_path(name)
        if op.tier == ops.Tier.READ:
            app.add_api_route(path, _make_get(name), methods=["GET"])
        else:
            app.add_api_route(path, _make_post(name), methods=["POST"])

    def _ops_meta(_: None = Depends(guard)):
        return ops.list_ops()

    app.add_api_route("/api/ops", _ops_meta, methods=["GET"])

    # Mounted last and deliberately unguarded: the browser needs the page
    # before any JS can send the token header. Safe because the bundle is app
    # code only, the token lives in the URL fragment (never in these files),
    # and every byte of data sits behind /api/*, which the guard does cover.
    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return app


def serve(host: str = "127.0.0.1", port: int = 8766, token: bool = True, open_browser: bool = False) -> None:
    if host in ("0.0.0.0", "::", "*"):
        raise ValueError(f"refusing to bind the web UI to {host!r}: loopback only")

    import socket

    import uvicorn

    tok = secrets.token_urlsafe(32) if token else None

    # Bind before building the app so a busy port fails fast, with a plain
    # message, instead of uvicorn's own startup failure several layers down.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError as e:
        sock.close()
        raise RuntimeError(f"cannot bind {host}:{port}: {e}") from e
    sock.listen(128)

    app = create_app(tok)
    app.state.port = port

    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(logger_name)
        logger.handlers = list(_LOGGER.handlers)
        logger.setLevel(logging.INFO)

    url = f"http://{host}:{port}/" + (f"#{tok}" if tok else "")
    print(url)
    if open_browser:
        import webbrowser

        webbrowser.open(url)

    config = uvicorn.Config(app, fd=sock.fileno(), log_level="info")
    server = uvicorn.Server(config)
    try:
        server.run()
    finally:
        sock.close()
