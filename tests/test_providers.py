"""Tests for sil.providers. Never touches a real network endpoint: every
test monkeypatches urllib.request.urlopen or subprocess.run."""

from __future__ import annotations

import json
import urllib.request as urllib_request

import pytest

from sil import config, providers
from sil.models import Endpoint, LlmConfig, World


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _deny_network(monkeypatch):
    def fail(*a, **kw):
        raise AssertionError("must not reach the network")

    monkeypatch.setattr(urllib_request, "urlopen", fail)


# --- openai kind: request shape -------------------------------------------------

def test_chat_openai_builds_url_headers_and_body(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        return FakeResponse(json.dumps({"choices": [{"message": {"content": "hello"}}]}).encode())

    monkeypatch.setattr(urllib_request, "urlopen", fake_urlopen)
    monkeypatch.setenv("TEST_KEY_ENV", "secret-123")

    endpoint = Endpoint(name="e1", kind="openai", base_url="http://localhost:4000/v1", api_key_env="TEST_KEY_ENV", timeout_s=30)
    llm = LlmConfig(endpoints=[endpoint], active="e1", models={"critic": "gpt-test"})
    world = World(name="w1", llm="cloud")

    result = providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm, json_mode=True)

    assert result == "hello"
    assert len(calls) == 1
    req = calls[0]
    assert req.full_url == "http://localhost:4000/v1/chat/completions"
    assert req.get_header("Authorization") == "Bearer secret-123"

    body = json.loads(req.data)
    assert body["model"] == "gpt-test"
    assert body["temperature"] == 0
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"] == [{"role": "user", "content": "hi"}]


def test_chat_openai_appends_v1_when_base_url_lacks_it(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        return FakeResponse(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())

    monkeypatch.setattr(urllib_request, "urlopen", fake_urlopen)
    endpoint = Endpoint(name="e1", kind="openai", base_url="http://localhost:4000", api_key_env=None)
    llm = LlmConfig(endpoints=[endpoint], active="e1", models={"critic": "gpt-test"})
    world = World(name="w1", llm="cloud")

    providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)

    assert calls[0].full_url == "http://localhost:4000/v1/chat/completions"
    assert calls[0].get_header("Authorization") is None  # no api_key_env: no auth header


# --- config errors propagate unwrapped ------------------------------------------

def test_chat_raises_model_not_configured_when_role_missing(monkeypatch):
    _deny_network(monkeypatch)
    endpoint = Endpoint(name="e1", kind="openai", base_url="http://localhost:4000", api_key_env=None)
    llm = LlmConfig(endpoints=[endpoint], active="e1", models={})  # no "critic" entry
    world = World(name="w1", llm="cloud")

    with pytest.raises(config.ModelNotConfigured):
        providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)


def test_chat_raises_locality_violation_for_local_world(monkeypatch):
    _deny_network(monkeypatch)
    endpoint = Endpoint(name="e1", kind="openai", base_url="http://localhost:4000", api_key_env=None)
    llm = LlmConfig(endpoints=[endpoint], active="e1", models={"critic": "gpt-cloud-only"}, local_models=["llama-local"])
    world = World(name="w1", llm="local")

    with pytest.raises(config.LocalityViolation):
        providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)


def test_chat_never_falls_back_to_localhost_when_base_url_missing(monkeypatch):
    _deny_network(monkeypatch)
    endpoint = Endpoint(name="e1", kind="openai", base_url=None, api_key_env=None)
    llm = LlmConfig(endpoints=[endpoint], active="e1", models={"critic": "gpt-test"})
    world = World(name="w1", llm="cloud")

    with pytest.raises(providers.ProviderError):
        providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)


def test_chat_raises_model_not_configured_with_no_endpoints_at_all(monkeypatch):
    _deny_network(monkeypatch)
    llm = LlmConfig(endpoints=[], active=None, models={"critic": "gpt-test"})
    world = World(name="w1", llm="cloud")

    with pytest.raises(config.ModelNotConfigured):
        providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)


# --- error surfaces name endpoint, url, status -----------------------------------

def test_chat_openai_http_error_names_endpoint_and_status(monkeypatch):
    import urllib.error

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 500, "boom", {}, None)

    monkeypatch.setattr(urllib_request, "urlopen", fake_urlopen)
    endpoint = Endpoint(name="myendpoint", kind="openai", base_url="http://localhost:4000", api_key_env=None)
    llm = LlmConfig(endpoints=[endpoint], active="myendpoint", models={"critic": "gpt-test"})
    world = World(name="w1", llm="cloud")

    with pytest.raises(providers.ProviderError) as exc:
        providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)
    assert "myendpoint" in str(exc.value)
    assert "500" in str(exc.value)


# --- claude-cli kind -------------------------------------------------------------

def test_chat_claude_cli_uses_result_field(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)

        class R:
            returncode = 0
            stdout = json.dumps({"result": "cli answer"})
            stderr = ""

        return R()

    monkeypatch.setattr(providers.subprocess, "run", fake_run)
    endpoint = Endpoint(name="cli", kind="claude-cli")
    llm = LlmConfig(endpoints=[endpoint], active="cli", models={"critic": "opus"})
    world = World(name="w1", llm="cloud")

    result = providers.chat(
        "critic", [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}], world=world, cfg_llm=llm
    )

    assert result == "cli answer"
    chat_call = next(c for c in calls if "-p" in c)
    assert "--model" in chat_call and "opus" in chat_call
    assert "--output-format" in chat_call and "json" in chat_call


def test_chat_claude_cli_raises_on_missing_result_field(monkeypatch):
    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = json.dumps({"not_result": "x"})
            stderr = ""

        return R()

    monkeypatch.setattr(providers.subprocess, "run", fake_run)
    endpoint = Endpoint(name="cli", kind="claude-cli")
    llm = LlmConfig(endpoints=[endpoint], active="cli", models={"critic": "opus"})
    world = World(name="w1", llm="cloud")

    with pytest.raises(providers.ProviderError):
        providers.chat("critic", [{"role": "user", "content": "hi"}], world=world, cfg_llm=llm)
