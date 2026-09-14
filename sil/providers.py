"""The single model transport. `chat()` is the only way any engine code talks
to a model. No base_url fallback, no placeholder key, no default model."""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request

from sil import config
from sil.models import Endpoint, LlmConfig, World


class ProviderError(RuntimeError):
    pass


class ProviderTimeout(ProviderError):
    pass


def chat(
    role: str,
    messages: list[dict],
    *,
    world: World,
    cfg_llm: LlmConfig | None = None,
    json_mode: bool = False,
    max_tokens: int = 4000,
) -> str:
    llm = cfg_llm if cfg_llm is not None else config.load_llm(world)
    endpoint = config.active_endpoint(llm)
    model = config.model_for(llm, role, world)  # enforces locality, raises on misconfig
    if endpoint.kind == "openai":
        return _chat_openai(endpoint, model, messages, json_mode=json_mode, max_tokens=max_tokens)
    if endpoint.kind == "claude-cli":
        return _chat_claude_cli(endpoint, model, messages, max_tokens=max_tokens)
    raise ProviderError(f"endpoint {endpoint.name!r} has unknown kind {endpoint.kind!r}")


def status(world: World, llm: LlmConfig | None = None) -> dict:
    from sil.models import ROLES

    result = {"endpoint": None, "kind": None, "base_url": None, "models": {}, "reachable": None, "error": None}
    llm = llm if llm is not None else config.load_llm(world)
    try:
        endpoint = config.active_endpoint(llm)
    except config.ConfigError as e:
        result["error"] = str(e)
        return result

    result["endpoint"] = endpoint.name
    result["kind"] = endpoint.kind
    result["base_url"] = endpoint.base_url
    for role in ROLES:
        try:
            result["models"][role] = config.model_for(llm, role, world)
        except config.ConfigError:
            result["models"][role] = None

    if endpoint.kind != "openai":
        return result

    base = (endpoint.base_url or "").rstrip("/")
    if not base:
        result["reachable"] = False
        result["error"] = "no base_url configured"
        return result
    try:
        key = config.api_key(endpoint)
    except config.ConfigError as e:
        result["reachable"] = False
        result["error"] = str(e)
        return result
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    url = _v1_url(base) + "/models"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
        result["reachable"] = True
    except Exception as e:  # a probe reports, never raises
        result["reachable"] = False
        result["error"] = f"{type(e).__name__}: {e}"
    return result


def _v1_url(base: str) -> str:
    return base if base.endswith("/v1") else base + "/v1"


def _chat_openai(endpoint: Endpoint, model: str, messages: list[dict], *, json_mode: bool, max_tokens: int) -> str:
    base = (endpoint.base_url or "").rstrip("/")
    if not base:
        raise ProviderError(f"endpoint {endpoint.name!r} has no base_url configured")
    url = _v1_url(base) + "/chat/completions"

    body = {"model": model, "messages": messages, "temperature": 0, "max_tokens": max_tokens}
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    headers = {"Content-Type": "application/json"}
    key = config.api_key(endpoint)
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=endpoint.timeout_s) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:300] if hasattr(e, "read") else b""
        raise ProviderError(
            f"provider {endpoint.name!r} at {url} answered HTTP {e.code}: {detail.decode('utf-8', 'replace')}"
        ) from e
    except TimeoutError as e:
        raise ProviderTimeout(f"provider {endpoint.name!r} at {url} timed out after {endpoint.timeout_s}s") from e
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            raise ProviderTimeout(f"provider {endpoint.name!r} at {url} timed out: {e}") from e
        raise ProviderError(f"provider {endpoint.name!r} at {url} unreachable: {e}") from e

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        head = raw[:300].decode("utf-8", "replace")
        raise ProviderError(f"provider {endpoint.name!r} at {url} returned non-JSON ({len(raw)} bytes): {head!r}") from e
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise ProviderError(f"provider {endpoint.name!r} at {url} reply has no choices[0].message.content") from e


def _cli_supports_no_session_persistence() -> bool:
    try:
        r = subprocess.run(["claude", "--help"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return "--no-session-persistence" in (r.stdout or "")


def _chat_claude_cli(endpoint: Endpoint, model: str, messages: list[dict], *, max_tokens: int) -> str:
    system_parts = [str(m.get("content", "")) for m in messages if m.get("role") == "system"]
    user_parts = [str(m.get("content", "")) for m in messages if m.get("role") != "system"]

    cmd = ["claude", "-p", "--model", model, "--output-format", "json"]
    if _cli_supports_no_session_persistence():
        cmd.append("--no-session-persistence")
    if system_parts:
        cmd += ["--append-system-prompt", "\n\n".join(system_parts)]

    try:
        r = subprocess.run(
            cmd, input="\n\n".join(user_parts), capture_output=True, text=True, timeout=endpoint.timeout_s
        )
    except subprocess.TimeoutExpired as e:
        raise ProviderTimeout(f"claude -p timed out after {endpoint.timeout_s}s") from e
    except (OSError, subprocess.SubprocessError) as e:
        raise ProviderError(f"failed to run claude -p: {e}") from e

    if r.returncode != 0:
        raise ProviderError(f"claude -p exited {r.returncode}: {(r.stderr or r.stdout)[:300]}")

    try:
        data = json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError) as e:
        raise ProviderError(f"claude -p returned non-JSON output: {r.stdout[:300]!r}") from e
    result = data.get("result") if isinstance(data, dict) else None
    if result is None:
        raise ProviderError(f"claude -p reply has no 'result' field: {str(data)[:300]!r}")
    return result
