"""Tests for sil/schedule.py. Never runs a real systemctl/launchctl: every
test monkeypatches subprocess.run and points Path.home() at a temp dir via
the HOME env var."""

from __future__ import annotations

import subprocess

import pytest

from sil import schedule


@pytest.fixture(autouse=True)
def fake_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def _deny_subprocess(monkeypatch):
    calls = []

    def fake_run(cmd, *a, **kw):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


# --- render_systemd -----------------------------------------------------------

def test_render_systemd_contains_shim_path_and_interval():
    units = schedule.render_systemd(interval_min=45, web=False)
    assert set(units.keys()) == {"sil-worker.service", "sil-worker.timer"}
    assert str(schedule.shim_path()) in units["sil-worker.service"]
    assert "OnUnitActiveSec=45min" in units["sil-worker.timer"]
    assert "OnBootSec=5min" in units["sil-worker.timer"]


def test_render_systemd_with_web_adds_web_unit():
    units = schedule.render_systemd(interval_min=60, web=True)
    assert "sil-web.service" in units
    assert "Restart=on-failure" in units["sil-web.service"]
    assert str(schedule.shim_path()) in units["sil-web.service"]


def test_render_systemd_no_long_dashes():
    units = schedule.render_systemd(interval_min=60, web=True)
    for content in units.values():
        assert "—" not in content
        assert "–" not in content


# --- render_launchd -------------------------------------------------------

def test_render_launchd_contains_shim_and_interval():
    units = schedule.render_launchd(interval_min=30, web=False)
    assert schedule.LAUNCHD_WORKER_PLIST in units
    content = units[schedule.LAUNCHD_WORKER_PLIST]
    assert str(schedule.shim_path()) in content
    assert "<key>StartInterval</key><integer>1800</integer>" in content


def test_render_launchd_with_web_adds_keepalive():
    units = schedule.render_launchd(interval_min=60, web=True)
    assert schedule.LAUNCHD_WEB_PLIST in units
    assert "<key>KeepAlive</key><true/>" in units[schedule.LAUNCHD_WEB_PLIST]


def test_render_launchd_no_long_dashes():
    units = schedule.render_launchd(interval_min=60, web=True)
    for content in units.values():
        assert "—" not in content
        assert "–" not in content


# --- install ----------------------------------------------------------------

def test_install_systemd_writes_files_under_fake_home(monkeypatch, fake_home):
    calls = _deny_subprocess(monkeypatch)
    written = schedule.install("systemd", interval_min=60, web=True)

    assert schedule.shim_path().is_file()
    assert schedule.shim_path().stat().st_mode & 0o111  # executable

    names = {p.name for p in written}
    assert names == {"sil-worker.service", "sil-worker.timer", "sil-web.service"}
    for p in written:
        assert p.is_file()
        assert str(fake_home) in str(p)

    joined = [" ".join(c) for c in calls]
    assert any("systemctl --user daemon-reload" in c for c in joined)
    assert any("systemctl --user enable --now sil-worker.timer" in c for c in joined)


def test_install_launchd_writes_files_and_loads(monkeypatch, fake_home):
    calls = _deny_subprocess(monkeypatch)
    written = schedule.install("launchd", interval_min=15, web=False)

    names = {p.name for p in written}
    assert names == {schedule.LAUNCHD_WORKER_PLIST}
    for p in written:
        assert p.is_file()

    joined = [" ".join(c) for c in calls]
    assert any("launchctl load" in c for c in joined)


def test_install_unknown_kind_raises():
    with pytest.raises(ValueError):
        schedule.install("cron")


# --- uninstall / show -------------------------------------------------------

def test_uninstall_removes_installed_files(monkeypatch, fake_home):
    _deny_subprocess(monkeypatch)
    schedule.install("systemd", interval_min=60, web=True)
    removed = schedule.uninstall("systemd")
    assert removed
    for p in removed:
        assert not p.exists()


def test_uninstall_nothing_installed_is_noop(monkeypatch, fake_home):
    _deny_subprocess(monkeypatch)
    removed = schedule.uninstall("systemd")
    assert removed == []


def test_show_reports_installed_units(monkeypatch, fake_home):
    _deny_subprocess(monkeypatch)
    assert schedule.show() == {"systemd": [], "launchd": []}
    schedule.install("systemd", interval_min=60, web=False)
    info = schedule.show()
    assert "sil-worker.service" in info["systemd"]
    assert "sil-worker.timer" in info["systemd"]
