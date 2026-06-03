import { getDb } from "./db.js";

export interface ChatSession {
  podId: string;
  sessionId: string;
  chatId: number;
  handle: string;
}

export interface TranscriptCursor {
  transcriptPath: string | null;
  byteOffset: number;
  lastUuid: string | null;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

export function validateHandle(raw: string): string {
  const h = normalizeHandle(raw);
  if (!HANDLE_RE.test(h)) {
    throw new Error("handle must be 1–32 chars: letters, digits, dash or underscore, no spaces");
  }
  if (handleTaken(h)) throw new Error(`@${h} is already taken`);
  return h;
}

export function handleTaken(handle: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM session_chat WHERE handle = ? COLLATE NOCASE")
      .get(normalizeHandle(handle))
  );
}

export function registerChatSession(podId: string, sessionId: string, chatId: number, handle: string): void {
  getDb()
    .prepare(
      "INSERT INTO session_chat (pod_id, session_id, chat_id, handle, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(podId, sessionId, chatId, normalizeHandle(handle), new Date().toISOString());
}

export function resolveHandle(handle: string): ChatSession | undefined {
  const row = getDb()
    .prepare(
      "SELECT pod_id AS podId, session_id AS sessionId, chat_id AS chatId, handle FROM session_chat WHERE handle = ? COLLATE NOCASE"
    )
    .get(normalizeHandle(handle)) as ChatSession | undefined;
  return row;
}

export function getChatSession(podId: string, sessionId: string): ChatSession | undefined {
  return getDb()
    .prepare(
      "SELECT pod_id AS podId, session_id AS sessionId, chat_id AS chatId, handle FROM session_chat WHERE pod_id = ? AND session_id = ?"
    )
    .get(podId, sessionId) as ChatSession | undefined;
}

// The chat a session should answer in right now: the last chat to address it, falling back to
// the chat that created it. Lets one @handle be driven from both a group and a DM.
export function setReplyChat(podId: string, sessionId: string, chatId: number): void {
  getDb()
    .prepare("UPDATE session_chat SET reply_chat_id = ? WHERE pod_id = ? AND session_id = ?")
    .run(chatId, podId, sessionId);
}

export function getReplyChat(podId: string, sessionId: string): number | undefined {
  const r = getDb()
    .prepare("SELECT COALESCE(reply_chat_id, chat_id) AS c FROM session_chat WHERE pod_id = ? AND session_id = ?")
    .get(podId, sessionId) as { c: number } | undefined;
  return r?.c;
}

export function listChatSessions(chatId?: number): ChatSession[] {
  const db = getDb();
  const cols = "pod_id AS podId, session_id AS sessionId, chat_id AS chatId, handle";
  return chatId === undefined
    ? (db.prepare(`SELECT ${cols} FROM session_chat ORDER BY created_at ASC`).all() as ChatSession[])
    : (db
        .prepare(`SELECT ${cols} FROM session_chat WHERE chat_id = ? ORDER BY created_at ASC`)
        .all(chatId) as ChatSession[]);
}

export function setFocus(chatId: number, podId: string, sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_focus (chat_id, pod_id, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET pod_id = excluded.pod_id, session_id = excluded.session_id, updated_at = excluded.updated_at`
    )
    .run(chatId, podId, sessionId, new Date().toISOString());
}

export function getFocus(chatId: number): { podId: string; sessionId: string } | undefined {
  return getDb()
    .prepare("SELECT pod_id AS podId, session_id AS sessionId FROM chat_focus WHERE chat_id = ?")
    .get(chatId) as { podId: string; sessionId: string } | undefined;
}

export function getTranscriptCursor(podId: string, sessionId: string): TranscriptCursor {
  const row = getDb()
    .prepare(
      "SELECT transcript_path AS transcriptPath, byte_offset AS byteOffset, last_uuid AS lastUuid FROM transcript_cursor WHERE pod_id = ? AND session_id = ?"
    )
    .get(podId, sessionId) as TranscriptCursor | undefined;
  return row ?? { transcriptPath: null, byteOffset: 0, lastUuid: null };
}

// Record the transcript path a chat session writes to (learned from the SessionStart hook),
// creating the cursor at offset 0 so a fresh session is forwarded from its first message.
export function setTranscriptPath(podId: string, sessionId: string, transcriptPath: string): void {
  getDb()
    .prepare(
      `INSERT INTO transcript_cursor (pod_id, session_id, transcript_path, byte_offset, updated_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(pod_id, session_id) DO UPDATE SET
         transcript_path = excluded.transcript_path, updated_at = excluded.updated_at`
    )
    .run(podId, sessionId, transcriptPath, new Date().toISOString());
}

export function setTranscriptCursor(podId: string, sessionId: string, c: TranscriptCursor): void {
  getDb()
    .prepare(
      `INSERT INTO transcript_cursor (pod_id, session_id, transcript_path, byte_offset, last_uuid, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pod_id, session_id) DO UPDATE SET
         transcript_path = excluded.transcript_path,
         byte_offset = excluded.byte_offset,
         last_uuid = excluded.last_uuid,
         updated_at = excluded.updated_at`
    )
    .run(podId, sessionId, c.transcriptPath, c.byteOffset, c.lastUuid, new Date().toISOString());
}

export function clearChatSession(podId: string, sessionId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_chat WHERE pod_id = ? AND session_id = ?").run(podId, sessionId);
  db.prepare("DELETE FROM transcript_cursor WHERE pod_id = ? AND session_id = ?").run(podId, sessionId);
  db.prepare("DELETE FROM chat_focus WHERE pod_id = ? AND session_id = ?").run(podId, sessionId);
}

export function clearChatSessionsForPod(podId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_chat WHERE pod_id = ?").run(podId);
  db.prepare("DELETE FROM transcript_cursor WHERE pod_id = ?").run(podId);
  db.prepare("DELETE FROM chat_focus WHERE pod_id = ?").run(podId);
}
