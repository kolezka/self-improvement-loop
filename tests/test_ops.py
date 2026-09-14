"""Tests for the ops registry: sil/ops.py.

Backend modules owned by other groups (sil.review, sil.run) may not exist yet,
so tests that need them install a fake module into sys.modules rather than
importing the real thing. Modules that already exist (sil.config, sil.store,
sil.worker, sil.feedback, sil.providers) are still monkeypatched function by
function, per the brief: don't depend on the other groups' real behaviour.
"""

from __future__ import annotations

import importlib
import json
import sys
import types

import pytest
from pydantic import ValidationError

from sil import ops


def install_fake_module(monkeypatch, name: str, **attrs):
    """Inject a throwaway module at `name` (e.g. "sil.review") so a lazy
    `from sil import review` inside an op function resolves to it."""
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    monkeypatch.setitem(sys.modules, name, mod)
    parent_name, _, attr = name.rpartition(".")
    if parent_name:
        parent = importlib.import_module(parent_name)
        monkeypatch.setattr(parent, attr, mod, raising=False)
    return mod


@pytest.fixture(autouse=True)
def isolated_dirs(monkeypatch, tmp_path):
    """Every test gets its own config/state/data dirs, never the real ones."""
    monkeypatch.setenv("SIL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("SIL_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("SIL_DATA_DIR", str(tmp_path / "data"))


# --- register() self-checks --------------------------------------------------

def test_remote_op_without_gate_raises(monkeypatch):
    monkeypatch.setattr(ops, "REGISTRY", {})
    op = ops.Op("test.remote", ops.Tier.REMOTE, ops.NoArgs, lambda a: None)
    with pytest.raises(ValueError, match="gate"):
        ops.register(op)


def test_duplicate_name_raises(monkeypatch):
    monkeypatch.setattr(ops, "REGISTRY", {})
    op = ops.Op("test.dup", ops.Tier.READ, ops.NoArgs, lambda a: None)
    ops.register(op)
    with pytest.raises(ValueError, match="duplicate"):
        ops.register(op)


@pytest.mark.parametrize("name", ["skill.accept", "router.push", "world.push_thing"])
def test_accept_or_push_name_must_be_remote(monkeypatch, name):
    monkeypatch.setattr(ops, "REGISTRY", {})
    op = ops.Op(name, ops.Tier.LOCAL, ops.NoArgs, lambda a: None)
    with pytest.raises(ValueError, match="REMOTE"):
        ops.register(op)


def test_real_registry_has_no_remote_op_without_a_gate():
    for op in ops.REGISTRY.values():
        if op.tier == ops.Tier.REMOTE:
            assert op.gate != ops.Gate.NONE, op.name


# --- invoke() validates args --------------------------------------------------

def test_invoke_rejects_bad_pattern_slug():
    with pytest.raises(ValidationError):
        ops.invoke("review.detail", {"world": "default", "pattern": "Not A Slug!"})


def test_invoke_rejects_short_reviewed_state():
    with pytest.raises(ValidationError):
        ops.invoke("skill.accept", {"world": "default", "pattern": "foo-bar", "reviewed_state": "abc"})


def test_invoke_rejects_non_hex_reviewed_state():
    with pytest.raises(ValidationError):
        ops.invoke("skill.accept", {"world": "default", "pattern": "foo-bar", "reviewed_state": "z" * 64})


def test_invoke_unknown_op_raises_value_error():
    with pytest.raises(ValueError, match="unknown op"):
        ops.invoke("nope.nope", {})


def test_router_retire_requires_confirm_true():
    with pytest.raises(ValidationError):
        ops.invoke("router.retire", {"world": "default", "pattern": "foo-bar"})
    with pytest.raises(ValidationError):
        ops.invoke("router.retire", {"world": "default", "pattern": "foo-bar", "confirm": False})


def test_aliases_set_rejects_non_slug_entries():
    with pytest.raises(ValidationError):
        ops.invoke("aliases.set", {"world": "default", "aliases": {"Bad Key": "ok-target"}})


def test_feedback_add_rejects_bad_ref_shape():
    with pytest.raises(ValidationError):
        ops.invoke("feedback.add", {"world": "default", "ref": "not-a-ref", "vote": "good"})


# --- table-driven tier check --------------------------------------------------

EXPECTED_TIERS = {
    "health.report": ops.Tier.READ,
    "worlds.list": ops.Tier.READ,
    "config.get": ops.Tier.READ,
    "config.set": ops.Tier.LOCAL,
    "llm.get": ops.Tier.READ,
    "llm.set": ops.Tier.LOCAL,
    "llm.status": ops.Tier.READ,
    "queue.list": ops.Tier.READ,
    "queue.skip": ops.Tier.LOCAL,
    "worker.status": ops.Tier.READ,
    "loop.run": ops.Tier.LOCAL,
    "curriculum.plan": ops.Tier.READ,
    "curriculum.run": ops.Tier.LOCAL,
    "reflections.list": ops.Tier.READ,
    "reflections.get": ops.Tier.READ,
    "aliases.get": ops.Tier.READ,
    "aliases.set": ops.Tier.LOCAL,
    "review.queue": ops.Tier.READ,
    "review.detail": ops.Tier.READ,
    "review.diff": ops.Tier.READ,
    "skill.accept": ops.Tier.REMOTE,
    "skill.reject": ops.Tier.LOCAL,
    "router.rehome": ops.Tier.LOCAL,
    "router.retire": ops.Tier.LOCAL,
    "router.inventory": ops.Tier.READ,
    "artifacts.scorecards": ops.Tier.READ,
    "artifacts.rebuild": ops.Tier.LOCAL,
    "feedback.add": ops.Tier.LOCAL,
    "lessons.list": ops.Tier.READ,
    "logs.tail": ops.Tier.READ,
}


@pytest.mark.parametrize("name,tier", sorted(EXPECTED_TIERS.items()))
def test_op_registered_with_expected_tier(name, tier):
    assert name in ops.REGISTRY, f"{name} is not registered"
    assert ops.REGISTRY[name].tier == tier


def test_registry_has_no_unexpected_ops():
    assert set(ops.REGISTRY) == set(EXPECTED_TIERS)


# --- logs.tail ----------------------------------------------------------------

def test_logs_tail_refuses_unknown_name():
    with pytest.raises(ValidationError):
        ops.invoke("logs.tail", {"name": "not-a-real-log"})


def test_logs_tail_reads_last_n_lines():
    from sil import paths

    log = paths.log_file("worker")
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("\n".join(f"line{i}" for i in range(10)) + "\n", encoding="utf-8")

    result = ops.invoke("logs.tail", {"name": "worker", "lines": 3})

    assert result["lines"] == ["line7", "line8", "line9"]


def test_logs_tail_missing_file_returns_empty():
    result = ops.invoke("logs.tail", {"name": "curriculum"})
    assert result["lines"] == []


# --- llm.get never leaks secrets ----------------------------------------------

def test_llm_get_never_returns_env_var_values(monkeypatch):
    monkeypatch.setenv("SIL_TEST_SECRET", "sk-super-secret-value")
    from sil import config as config_mod
    from sil.models import Endpoint, LlmConfig

    llm = LlmConfig(
        endpoints=[Endpoint(name="litellm", api_key_env="SIL_TEST_SECRET")],
        active="litellm",
    )
    config_mod.save_llm(llm)

    result = ops.invoke("llm.get", {})

    assert "sk-super-secret-value" not in json.dumps(result)
    assert result["endpoints"][0]["api_key_env"] == "SIL_TEST_SECRET"


# --- loop.run spawns detached --------------------------------------------------

def test_loop_run_spawns_detached_worker(monkeypatch):
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", "/plugin/root")
    calls = {}

    class FakeProc:
        pid = 4242

    def fake_popen(cmd, **kwargs):
        calls["cmd"] = cmd
        calls["kwargs"] = kwargs
        return FakeProc()

    monkeypatch.setattr(ops.subprocess, "Popen", fake_popen)

    result = ops.invoke("loop.run", {"world": "default"})

    assert calls["cmd"] == [
        "uv", "run", "--project", "/plugin/root", "sil", "worker", "--once", "--world", "default",
    ]
    assert calls["kwargs"]["start_new_session"] is True
    assert result["pid"] == 4242
    assert result["log"].endswith("worker.log")


def test_curriculum_run_spawns_detached(monkeypatch):
    calls = {}

    class FakeProc:
        pid = 99

    def fake_popen(cmd, **kwargs):
        calls["cmd"] = cmd
        calls["kwargs"] = kwargs
        return FakeProc()

    monkeypatch.setattr(ops.subprocess, "Popen", fake_popen)

    result = ops.invoke("curriculum.run", {"world": "default"})

    assert calls["cmd"] == ["sil", "curriculum", "run", "--apply", "--world", "default"]
    assert calls["kwargs"]["start_new_session"] is True
    assert result["pid"] == 99


# --- skill.accept passes reviewed_state through --------------------------------

def test_skill_accept_passes_reviewed_state_through(monkeypatch):
    captured = {}

    def fake_accept(world, cfg, pattern, reviewed_state):
        captured["args"] = (world.name, pattern, reviewed_state)
        return {"merged": True, "pr": None}

    install_fake_module(monkeypatch, "sil.review", accept=fake_accept)

    digest = "a" * 64
    result = ops.invoke(
        "skill.accept",
        {"world": "default", "pattern": "foo-bar", "reviewed_state": digest},
    )

    assert captured["args"] == ("default", "foo-bar", digest)
    assert result == {"merged": True, "pr": None}


def test_router_retire_calls_review_retire_with_confirm(monkeypatch):
    captured = {}

    def fake_retire(world, cfg, pattern):
        captured["args"] = (world.name, pattern)
        return {"retired": True}

    install_fake_module(monkeypatch, "sil.review", retire=fake_retire)

    result = ops.invoke(
        "router.retire",
        {"world": "default", "pattern": "foo-bar", "confirm": True},
    )

    assert captured["args"] == ("default", "foo-bar")
    assert result == {"retired": True}


# --- queue.list combines three buckets -----------------------------------------

def test_queue_list_combines_three_buckets(monkeypatch):
    from sil import worker

    def fake_queue_list(bucket):
        return [{"bucket": bucket}]

    monkeypatch.setattr(worker, "queue_list", fake_queue_list)

    result = ops.invoke("queue.list", {})

    assert result == {
        "pending": [{"bucket": "pending"}],
        "done": [{"bucket": "done"}],
        "failed": [{"bucket": "failed"}],
    }
