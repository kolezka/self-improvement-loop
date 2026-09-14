"""Tests for the FastAPI shell: sil/web/server.py.

Route generation and error mapping are exercised against the real ops
registry (sil.ops), but every op's `fn` is monkeypatched where a test needs a
specific outcome, never left to call other groups' real backends.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sil import ops
from sil.web import server

TOKEN = "test-token-value"
PORT = 9123
GOOD_HEADERS = {"X-SIL-Local": "1", "X-SIL-Token": TOKEN}


@pytest.fixture(autouse=True)
def isolated_dirs(monkeypatch, tmp_path):
    monkeypatch.setenv("SIL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("SIL_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("SIL_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def client():
    app = server.create_app(TOKEN)
    app.state.port = PORT
    return TestClient(app, base_url=f"http://127.0.0.1:{PORT}")


# --- routing: every op gets the right method at the right path ---------------

def test_every_registered_op_has_a_route_with_the_right_method(client):
    routes_by_path = {}
    for route in client.app.routes:
        methods = getattr(route, "methods", None)
        if methods:
            routes_by_path[route.path] = methods

    for name, op in ops.REGISTRY.items():
        path = server.op_path(name)
        assert path in routes_by_path, f"no route for {name} at {path}"
        expected = {"GET"} if op.tier == ops.Tier.READ else {"POST"}
        assert expected <= routes_by_path[path], f"{name}: expected {expected}, got {routes_by_path[path]}"


def test_get_api_ops_lists_every_op(client):
    res = client.get("/api/ops", headers=GOOD_HEADERS)
    assert res.status_code == 200
    body = res.json()
    assert {item["name"] for item in body} == set(ops.REGISTRY)


# --- guard --------------------------------------------------------------------

def test_guard_rejects_missing_local_header(client):
    res = client.get("/api/ops", headers={"X-SIL-Token": TOKEN})
    assert res.status_code == 401


def test_guard_rejects_bad_host(client):
    res = client.get("/api/ops", headers={**GOOD_HEADERS, "host": "evil.example:9123"})
    assert res.status_code == 403


def test_guard_rejects_wrong_token(client):
    res = client.get("/api/ops", headers={"X-SIL-Local": "1", "X-SIL-Token": "not-the-token"})
    assert res.status_code == 401


def test_guard_accepts_good_headers(client):
    res = client.get("/api/ops", headers=GOOD_HEADERS)
    assert res.status_code == 200


def test_tokenless_mode_skips_token_check():
    app = server.create_app(None)
    app.state.port = PORT
    client = TestClient(app, base_url=f"http://127.0.0.1:{PORT}")
    res = client.get("/api/ops", headers={"X-SIL-Local": "1"})
    assert res.status_code == 200


def test_env_allowed_host_is_accepted(monkeypatch, client):
    monkeypatch.setenv("SIL_WEB_ALLOWED_HOSTS", "my-box.local:9123")
    res = client.get("/api/ops", headers={**GOOD_HEADERS, "host": "my-box.local:9123"})
    assert res.status_code == 200


# --- error mapping -------------------------------------------------------------

def test_post_validation_error_returns_400(client):
    res = client.post("/api/queue/skip", headers=GOOD_HEADERS, json={})
    assert res.status_code == 400
    assert "detail" in res.json()


def test_config_error_maps_to_503(monkeypatch, client):
    from sil.config import ConfigError

    def raiser(name, payload):
        raise ConfigError("no config file")

    monkeypatch.setattr(server.ops, "invoke", raiser)
    res = client.get("/api/health/report", headers=GOOD_HEADERS)
    assert res.status_code == 503
    assert res.json()["detail"] == "no config file"


def test_provider_timeout_maps_to_504(monkeypatch, client):
    from sil.providers import ProviderTimeout

    def raiser(name, payload):
        raise ProviderTimeout("model did not answer")

    monkeypatch.setattr(server.ops, "invoke", raiser)
    res = client.get("/api/health/report", headers=GOOD_HEADERS)
    assert res.status_code == 504


def test_provider_error_maps_to_502(monkeypatch, client):
    from sil.providers import ProviderError

    def raiser(name, payload):
        raise ProviderError("endpoint refused")

    monkeypatch.setattr(server.ops, "invoke", raiser)
    res = client.get("/api/health/report", headers=GOOD_HEADERS)
    assert res.status_code == 502


def test_called_process_error_maps_to_502_with_stderr_tail(monkeypatch, client):
    def raiser(name, payload):
        raise subprocess.CalledProcessError(1, ["sil", "curriculum"], stderr=b"boom: no such branch")

    monkeypatch.setattr(server.ops, "invoke", raiser)
    res = client.get("/api/health/report", headers=GOOD_HEADERS)
    assert res.status_code == 502
    assert "boom: no such branch" in res.json()["detail"]


def test_generic_exception_maps_to_500_with_class_name(monkeypatch, client):
    def raiser(name, payload):
        raise RuntimeError("something internal broke")

    monkeypatch.setattr(server.ops, "invoke", raiser)
    res = client.get("/api/health/report", headers=GOOD_HEADERS)
    assert res.status_code == 500
    assert res.json()["detail"] == "RuntimeError"


# --- S1: queue.skip rejects a path-traversal session_id at the HTTP boundary ----

def test_queue_skip_rejects_path_traversal_session_id(tmp_path, client):
    res = client.post("/api/queue/skip", headers=GOOD_HEADERS, json={"session_id": "../../x"})
    assert res.status_code == 400
    assert not any(tmp_path.rglob("x.json"))


# --- S3: world args reject argv-flag-shaped values, unknown worlds 503 ----------

def test_loop_run_flag_like_world_maps_to_400(client):
    res = client.post("/api/loop/run", headers=GOOD_HEADERS, json={"world": "--no-curriculum"})
    assert res.status_code == 400


def test_loop_run_unknown_world_maps_to_503(client):
    res = client.post("/api/loop/run", headers=GOOD_HEADERS, json={"world": "no-such-world"})
    assert res.status_code == 503


# --- static files ---------------------------------------------------------------

def test_static_index_served_at_root_without_guard(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]


def test_static_js_files_are_served(client):
    res = client.get("/app.js")
    assert res.status_code == 200


# --- serve() refuses non-loopback hosts -----------------------------------------

@pytest.mark.parametrize("host", ["0.0.0.0", "::", "*"])
def test_serve_refuses_non_loopback_host(host):
    with pytest.raises(ValueError, match="loopback"):
        server.serve(host=host)


# --- frontend JS syntax --------------------------------------------------------

STATIC_DIR = Path(__file__).resolve().parent.parent / "sil" / "web" / "static"
JS_FILES = sorted(STATIC_DIR.glob("*.js")) + sorted((STATIC_DIR / "panes").glob("*.js"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
@pytest.mark.parametrize("js_path", JS_FILES, ids=[str(p.relative_to(STATIC_DIR)) for p in JS_FILES])
def test_static_js_file_has_valid_syntax(js_path):
    result = subprocess.run(
        [shutil.which("node"), "--check", str(js_path)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
