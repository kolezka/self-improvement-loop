"""self-improvement-loop engine.

Two halves share this package:

* ``sil.hook`` is the in-session fast path. It must import only the standard
  library plus ``sil.paths`` and ``sil.nudge`` (both stdlib-only), because it
  runs on every hook event with ``python3`` and no virtualenv.
* Everything else (worker, critic, curriculum, web) runs under
  ``uv run --project <plugin root>`` and may use pydantic, yaml, fastapi.

Keep that boundary: a third-party import in the hook path breaks every session.
"""

__version__ = "0.1.0"
