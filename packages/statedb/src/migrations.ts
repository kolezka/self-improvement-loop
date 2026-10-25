// The loop-state schema ladder. Migrations are the only DDL: each step runs once,
// in order, and PRAGMA user_version records the last one applied.

import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  up(db: Database): void;
}

// Copied from the D7 "v1 (phase 1)" block of the loop-state design.
const V1 = `
-- v1 (phase 1)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE log_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,          -- 'reflect_runs' | 'critic' | 'human' | 'proposal_events' (phase 3 adds more)
  ts TEXT,                       -- the record's own ts, as written; null when it has none
  world TEXT,                    -- NFC of the record's world field; null when it has none
  body TEXT NOT NULL CHECK (json_valid(body)),  -- the exact JSON line, minus newline
  recorded_at TEXT NOT NULL,     -- when this row was inserted
  import_id INTEGER REFERENCES legacy_imports(id)
);
CREATE INDEX log_records_stream_world_ts ON log_records (stream, world, ts);
CREATE INDEX log_records_stream_id ON log_records (stream, id);
CREATE INDEX log_records_import ON log_records (import_id) WHERE import_id IS NOT NULL;
CREATE TABLE legacy_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT NOT NULL,             -- 'reflect_runs' | 'critic' | 'human' | 'proposal_events' | later phases
  world TEXT,                      -- per-world stores only (payloads, refine attempts); else null
  original_path TEXT NOT NULL,     -- P
  backup_path TEXT,                -- P.imported-<stamp>-<id>, set in the verifying transaction
  state TEXT NOT NULL CHECK (state IN ('verified', 'failed')),
  lines_imported INTEGER NOT NULL DEFAULT 0,
  lines_quarantined INTEGER NOT NULL DEFAULT 0,
  lines_blank INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT, size INTEGER, dev INTEGER, ino INTEGER,   -- of the bytes read; size grows on a late-append import
  failure TEXT,                    -- reason when state = 'failed'
  started_at TEXT NOT NULL, verified_at TEXT);
CREATE INDEX legacy_imports_store_state ON legacy_imports (store, state);
CREATE TABLE quarantine (id INTEGER PRIMARY KEY, store TEXT NOT NULL, source TEXT NOT NULL,
  import_id INTEGER REFERENCES legacy_imports(id),
  line_no INTEGER, reason TEXT NOT NULL, raw TEXT NOT NULL, quarantined_at TEXT NOT NULL);
CREATE INDEX quarantine_store ON quarantine (store);
CREATE INDEX legacy_imports_inode ON legacy_imports (store, dev, ino);
-- meta keys: created_at, fs_class, fs_dev, fs_probed_at
`;

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.run(V1) }];

export const SCHEMA_VERSION = 1;
