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
from pathlib import Path

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

def _fake_entry(session_id: str, last_stop: str):
    from sil.models import QueueEntry

    return QueueEntry(
        session_id=session_id,
        transcript_path=f"/tmp/{session_id}.jsonl",
        cwd="/tmp",
        world="default",
        first_stop=last_stop,
        last_stop=last_stop,
    )


def test_queue_list_combines_three_buckets(monkeypatch):
    from sil import worker

    def fake_queue_list(bucket):
        return [_fake_entry(f"sess-{bucket}", "2026-09-14T10:00:00Z")]

    monkeypatch.setattr(worker, "queue_list", fake_queue_list)

    result = ops.invoke("queue.list", {})

    assert {e["session_id"] for e in result["pending"]} == {"sess-pending"}
    assert {e["session_id"] for e in result["done"]} == {"sess-done"}
    assert {e["session_id"] for e in result["failed"]} == {"sess-failed"}


# --- S4: queue.list caps each bucket at the most recent 200 entries ------------

def test_queue_list_caps_each_bucket_at_200_most_recent(monkeypatch):
    from datetime import datetime, timedelta, timezone

    from sil import worker

    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    entries = [
        _fake_entry(f"sess-{i}", (base + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        for i in range(250)
    ]

    def fake_queue_list(bucket):
        return list(entries)  # same 250 entries in every bucket, order doesn't matter

    monkeypatch.setattr(worker, "queue_list", fake_queue_list)

    result = ops.invoke("queue.list", {})

    assert len(result["pending"]) == 200
    assert len(result["done"]) == 200
    assert len(result["failed"]) == 200
    # kept the newest by last_stop, not an arbitrary prefix
    kept_ids = {e["session_id"] for e in result["pending"]}
    assert kept_ids == {f"sess-{i}" for i in range(50, 250)}


# --- S1: queue.skip rejects a traversal-shaped session_id -----------------------

def test_queue_skip_rejects_traversal_session_id():
    with pytest.raises(ValidationError):
        ops.invoke("queue.skip", {"session_id": "../../x"})


def test_queue_skip_accepts_a_normal_session_id():
    # min bar: a realistic Claude Code session uuid must still validate
    ops.SessionArgs(session_id="a1b2c3d4-e5f6-7890-abcd-ef1234567890")


# --- S3: world args reject argv-flag-shaped values, unknown worlds 503 ----------

def test_loop_run_rejects_flag_like_world():
    with pytest.raises(ValidationError):
        ops.invoke("loop.run", {"world": "--no-curriculum"})


def test_curriculum_run_rejects_flag_like_world():
    with pytest.raises(ValidationError):
        ops.invoke("curriculum.run", {"world": "--no-curriculum"})


def test_loop_run_rejects_unknown_world_with_config_error():
    from sil.config import ConfigError

    with pytest.raises(ConfigError):
        ops.invoke("loop.run", {"world": "no-such-world"})


# --- S4: reflections.list defaults to the newest 200 -----------------------------

def test_reflections_list_defaults_to_200_limit(monkeypatch):
    from sil import store as store_mod
    from sil.models import Reflection

    def fake_list_reflections(world, extra_dirs=None):
        return [
            Reflection(id=f"r{i}", world=world, pattern="some-pattern", path=Path(f"/tmp/r{i}.md"), created="2026-01-01")
            for i in range(250)
        ]

    monkeypatch.setattr(store_mod, "list_reflections", fake_list_reflections)

    result = ops.invoke("reflections.list", {"world": "default"})

    assert len(result) == 200


def test_reflections_list_rejects_limit_above_2000():
    with pytest.raises(ValidationError):
        ops.invoke("reflections.list", {"world": "default", "limit": 2001})


# --- S5: _tail_lines reads from the end without loading the whole file ----------

def test_tail_lines_large_file_reverse_chunked_read(tmp_path):
    log = tmp_path / "big.log"
    with log.open("w", encoding="utf-8") as fh:
        for i in range(100_000):  # 50 bytes/line * 100_000 = 5 MB
            fh.write(f"line{i:06d}".ljust(49) + "\n")

    result = ops._tail_lines(log, 10)

    assert result == [f"line{i:06d}".ljust(49) for i in range(99_990, 100_000)]


def test_tail_lines_large_file_does_not_read_whole_file(tmp_path, monkeypatch):
    # The bug this guards: a naive tail reads the entire file into memory.
    # Wrap the real file so we can count bytes actually read, and assert
    # that count stays far below the file size for a small tail request.
    log = tmp_path / "big.log"
    with log.open("w", encoding="utf-8") as fh:
        for i in range(100_000):  # 50 bytes/line * 100_000 = 5 MB
            fh.write(f"line{i:06d}".ljust(49) + "\n")
    file_size = log.stat().st_size
    assert file_size > 4_000_000

    real_open = Path.open
    bytes_read = {"total": 0}

    def counting_open(self, mode="r", *args, **kwargs):
        fh = real_open(self, mode, *args, **kwargs)
        if self == log:
            real_read = fh.read

            def counted_read(size=-1):
                data = real_read(size)
                bytes_read["total"] += len(data)
                return data

            fh.read = counted_read
        return fh

    monkeypatch.setattr(Path, "open", counting_open)

    result = ops._tail_lines(log, 10)

    assert result == [f"line{i:06d}".ljust(49) for i in range(99_990, 100_000)]
    assert bytes_read["total"] < 200_000, f"read {bytes_read['total']} bytes of a {file_size} byte file"


def test_tail_lines_file_smaller_than_one_block(tmp_path):
    log = tmp_path / "small.log"
    log.write_text("a\nb\nc\n", encoding="utf-8")

    assert ops._tail_lines(log, 2) == ["b", "c"]


def test_tail_lines_missing_file_returns_empty_list(tmp_path):
    assert ops._tail_lines(tmp_path / "nope.log", 10) == []


def test_health_report_passes_world_objects_to_provider_status(monkeypatch):
    """health.report used to pass the world NAME, so every provider status row
    was an AttributeError rendered in the Overview pane."""
    seen = []

    def fake_status(world, llm=None):
        seen.append(type(world).__name__)
        return {"reachable": True}

    install_fake_module(monkeypatch, "sil.providers", status=fake_status)
    report = ops.invoke("health.report", {})
    assert seen and set(seen) == {"World"}
    assert all("error" not in v for v in report["providers"].values()), report["providers"]
