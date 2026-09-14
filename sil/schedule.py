"""Render and install systemd user units / launchd agents for the worker and web UI.

Every unit's ExecStart points at the shim `~/.local/bin/sil`
(`scripts/sil`, installed here), never at a path inside one plugin version.
A plugin upgrade changes `${CLAUDE_PLUGIN_ROOT}`; the shim resolves the
current install at call time, so an installed schedule never goes stale.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

SYSTEMD_WORKER_UNITS = ("sil-worker.service", "sil-worker.timer")
SYSTEMD_WEB_UNIT = "sil-web.service"
LAUNCHD_WORKER_PLIST = "com.kolezka.sil-worker.plist"
LAUNCHD_WEB_PLIST = "com.kolezka.sil-web.plist"


def shim_path() -> Path:
    return Path.home() / ".local" / "bin" / "sil"


def systemd_dir() -> Path:
    return Path.home() / ".config" / "systemd" / "user"


def launchd_dir() -> Path:
    return Path.home() / "Library" / "LaunchAgents"


def render_systemd(interval_min: int, web: bool) -> dict[str, str]:
    shim = str(shim_path())
    units = {
        "sil-worker.service": (
            "[Unit]\n"
            "Description=self-improvement-loop worker, one pass\n\n"
            "[Service]\n"
            "Type=oneshot\n"
            f"ExecStart={shim} worker --once\n"
        ),
        "sil-worker.timer": (
            "[Unit]\n"
            "Description=self-improvement-loop worker schedule\n\n"
            "[Timer]\n"
            "OnBootSec=5min\n"
            f"OnUnitActiveSec={interval_min}min\n\n"
            "[Install]\n"
            "WantedBy=timers.target\n"
        ),
    }
    if web:
        units[SYSTEMD_WEB_UNIT] = (
            "[Unit]\n"
            "Description=self-improvement-loop web UI\n\n"
            "[Service]\n"
            "Type=simple\n"
            f"ExecStart={shim} web\n"
            "Restart=on-failure\n\n"
            "[Install]\n"
            "WantedBy=default.target\n"
        )
    return units


def render_launchd(interval_min: int, web: bool) -> dict[str, str]:
    shim = str(shim_path())
    interval_s = interval_min * 60
    units = {
        LAUNCHD_WORKER_PLIST: (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            "  <key>Label</key><string>com.kolezka.sil-worker</string>\n"
            "  <key>ProgramArguments</key><array>\n"
            f"    <string>{shim}</string>\n"
            "    <string>worker</string>\n"
            "    <string>--once</string>\n"
            "  </array>\n"
            f"  <key>StartInterval</key><integer>{interval_s}</integer>\n"
            "  <key>RunAtLoad</key><true/>\n"
            "</dict></plist>\n"
        )
    }
    if web:
        units[LAUNCHD_WEB_PLIST] = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            "  <key>Label</key><string>com.kolezka.sil-web</string>\n"
            "  <key>ProgramArguments</key><array>\n"
            f"    <string>{shim}</string>\n"
            "    <string>web</string>\n"
            "  </array>\n"
            "  <key>KeepAlive</key><true/>\n"
            "  <key>RunAtLoad</key><true/>\n"
            "</dict></plist>\n"
        )
    return units


def _install_shim() -> Path:
    dest = shim_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = Path(__file__).resolve().parent.parent / "scripts" / "sil"
    shutil.copy2(src, dest)
    dest.chmod(0o755)
    return dest


def install(kind: str, interval_min: int = 60, web: bool = False) -> list[Path]:
    """Write the units for `kind` (systemd | launchd) and load them. Returns the
    written file paths. Idempotent: re-running overwrites the same files."""
    _install_shim()
    if kind == "systemd":
        d = systemd_dir()
        d.mkdir(parents=True, exist_ok=True)
        written = []
        for name, content in render_systemd(interval_min, web).items():
            p = d / name
            p.write_text(content, encoding="utf-8")
            written.append(p)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
        subprocess.run(["systemctl", "--user", "enable", "--now", "sil-worker.timer"], check=False)
        if web:
            subprocess.run(["systemctl", "--user", "enable", "--now", SYSTEMD_WEB_UNIT], check=False)
        return written
    if kind == "launchd":
        d = launchd_dir()
        d.mkdir(parents=True, exist_ok=True)
        written = []
        for name, content in render_launchd(interval_min, web).items():
            p = d / name
            p.write_text(content, encoding="utf-8")
            written.append(p)
            subprocess.run(["launchctl", "load", str(p)], check=False)
        return written
    raise ValueError(f"unknown schedule kind: {kind!r}, use systemd or launchd")


def uninstall(kind: str) -> list[Path]:
    """Stop and remove whatever units of `kind` are installed. A no-op, not an
    error, when nothing is installed."""
    if kind == "systemd":
        d = systemd_dir()
        subprocess.run(["systemctl", "--user", "disable", "--now", "sil-worker.timer"], check=False)
        subprocess.run(["systemctl", "--user", "disable", "--now", SYSTEMD_WEB_UNIT], check=False)
        removed = []
        for name in (*SYSTEMD_WORKER_UNITS, SYSTEMD_WEB_UNIT):
            p = d / name
            if p.exists():
                p.unlink()
                removed.append(p)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
        return removed
    if kind == "launchd":
        d = launchd_dir()
        removed = []
        for name in (LAUNCHD_WORKER_PLIST, LAUNCHD_WEB_PLIST):
            p = d / name
            if p.exists():
                subprocess.run(["launchctl", "unload", str(p)], check=False)
                p.unlink()
                removed.append(p)
        return removed
    raise ValueError(f"unknown schedule kind: {kind!r}, use systemd or launchd")


def show() -> dict[str, list[str]]:
    """What is currently installed, by kind. Reads the filesystem, runs nothing."""
    d = systemd_dir()
    systemd = sorted(p.name for p in d.glob("sil-*")) if d.exists() else []
    ld = launchd_dir()
    launchd = sorted(p.name for p in ld.glob("com.kolezka.sil-*.plist")) if ld.exists() else []
    return {"systemd": systemd, "launchd": launchd}
