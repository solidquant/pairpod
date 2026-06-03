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

  // Multi-user access. users is the roster (owners flagged); pod_access holds per-pod
  // writer/reader grants for guests; pending_invites parks grants issued by @username before
  // that user's numeric id is known (pod_id '' = a global owner grant from the env allowlist).
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id    INTEGER PRIMARY KEY,
      username   TEXT,
      is_owner   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pod_access (
      user_id    INTEGER NOT NULL,
      pod_id     TEXT NOT NULL,
      role       TEXT NOT NULL,
      granted_by INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, pod_id)
    );

    CREATE TABLE IF NOT EXISTS pending_invites (
      username   TEXT NOT NULL,
      pod_id     TEXT NOT NULL DEFAULT '',
      role       TEXT NOT NULL,
      invited_by INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (username, pod_id)
    );
  `);

  // Spool tailer progress per pod. byte_offset skips already-read bytes on a fresh
  // connect; last_ts is the authoritative dedup watermark (max event ts delivered) so
  // a reconnect, restart, or spool rotation never re-sends an event.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_cursor (
      pod_id TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  // Telegram chat-bridged sessions: which chat a chat-mode session talks to, plus its
  // unique @handle (the only addressable name). chat_focus is the session a chat is
  // currently addressing (sticky after the last @mention). transcript_cursor resumes the
  // per-session transcript tail; last_uuid is the dedup watermark across compaction/rotation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_chat (
      pod_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      handle TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pod_id, session_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_chat_handle ON session_chat (handle COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS chat_focus (
      chat_id INTEGER PRIMARY KEY,
      pod_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transcript_cursor (
      pod_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      transcript_path TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_uuid TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (pod_id, session_id)
    );
  `);

  // A chat session answers in whichever chat last addressed it (reply_chat_id), not only the
  // chat that created it — so @handle from a group is answered in the group, not a DM.
  try { db.exec(`ALTER TABLE session_chat ADD COLUMN reply_chat_id INTEGER`); } catch {}

  // The single "writer" role was split into writer-full / writer-chat; migrate existing grants.
  try { db.exec(`UPDATE pod_access SET role = 'writer-full' WHERE role = 'writer'`); } catch {}
  try { db.exec(`UPDATE pending_invites SET role = 'writer-full' WHERE role = 'writer'`); } catch {}
}
