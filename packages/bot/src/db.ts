import Database from "better-sqlite3";
import { config } from "./config.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  // Legacy rename (v1 "projects" -> "pods"). No-ops on already-migrated / fresh DBs.
  try { db.exec(`ALTER TABLE projects RENAME TO pods`); } catch {}
  try { db.exec(`ALTER TABLE sessions RENAME COLUMN project_id TO pod_id`); } catch {}
  try { db.exec(`ALTER TABLE tg_session_state RENAME COLUMN project_id TO pod_id`); } catch {}
  try { db.exec(`UPDATE counters SET name = 'pods' WHERE name = 'projects'`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS pods (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT NOT NULL,
      pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pod_id, id)
    );
  `);

  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`);
  } catch {}

  for (const col of [
    `ALTER TABLE pods ADD COLUMN kind TEXT NOT NULL DEFAULT 'docker'`,
    `ALTER TABLE pods ADD COLUMN label TEXT`,
    `ALTER TABLE pods ADD COLUMN ssh_host TEXT`,
    `ALTER TABLE pods ADD COLUMN ssh_port INTEGER`,
    `ALTER TABLE pods ADD COLUMN ssh_user TEXT`,
    `ALTER TABLE pods ADD COLUMN ssh_auth TEXT`,
    `ALTER TABLE pods ADD COLUMN ssh_key_path TEXT`,
    `ALTER TABLE pods ADD COLUMN ssh_vault_ref TEXT`,
    `ALTER TABLE pods ADD COLUMN host_fingerprint TEXT`,
    `ALTER TABLE pods ADD COLUMN remote_cwd TEXT`,
  ]) {
    try {
      db.exec(col);
    } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_session_state (
      user_id INTEGER NOT NULL,
      pod_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_seen_uuid TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, pod_id, session_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
}
