import { getPodRow, type PodRow } from "./store.js";
import { targetForPod } from "./targets/index.js";
import type { PodTarget } from "./targets/types.js";
import { consume } from "./spool-stream.js";
import { extractForwardable } from "./transcript.js";
import { sendChatMessage } from "./notifier.js";
import { listChatSessions, getTranscriptCursor, setTranscriptCursor, getReplyChat, type ChatSession } from "./chat-store.js";

const RECONCILE_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

interface Tailer {
  stopped: boolean;
  close?: () => void;
}

interface Bridge {
  pod: PodRow;
  chat: ChatSession;
  transcriptPath: string;
  prefix: string;
}

const tailers = new Map<string, Tailer>();

export function startTranscriptTailers(): void {
  reconcile();
  setInterval(reconcile, RECONCILE_MS).unref();
}

// Start following without waiting for the next tick — called the moment a session's
// transcript path is learned, so a fresh chat session's first reply isn't tick-delayed.
export function kickTranscriptTailers(): void {
  reconcile();
}

function reconcile(): void {
  const want = new Map<string, Bridge>();
  for (const chat of listChatSessions()) {
    const pod = getPodRow(chat.podId);
    if (!pod || pod.status !== "running" || pod.kind === "local") continue;
    const cur = getTranscriptCursor(chat.podId, chat.sessionId);
    if (!cur.transcriptPath) continue; // wait for the SessionStart hook to report the path
    const prefix = `${pod.label?.trim() || pod.id}:${chat.handle}`;
    want.set(key(chat.podId, chat.sessionId), { pod, chat, transcriptPath: cur.transcriptPath, prefix });
  }

  for (const [k, t] of tailers) {
    if (!want.has(k)) {
      t.stopped = true;
      t.close?.();
      tailers.delete(k);
    }
  }
  for (const [k, bridge] of want) {
    if (!tailers.has(k)) {
      const t: Tailer = { stopped: false };
      tailers.set(k, t);
      runTailer(bridge, t).catch(() => tailers.delete(k));
    }
  }
}

async function runTailer(bridge: Bridge, t: Tailer): Promise<void> {
  const { pod, chat, transcriptPath, prefix } = bridge;
  let backoff = 1_000;
  let lastUuid = getTranscriptCursor(chat.podId, chat.sessionId).lastUuid;

  while (!t.stopped) {
    try {
      const target = targetForPod(pod);
      const size = await fileSize(target, transcriptPath);
      let offset = initOffset(chat.podId, chat.sessionId, transcriptPath, size);
      const cmd = ["sh", "-c", `exec tail -c +${offset + 1} -F "$1" 2>/dev/null`, "sh", transcriptPath];
      const { stream, close } = await target.execStream(cmd);
      t.close = close;
      backoff = 1_000;
      offset = await consume(
        stream,
        offset,
        (line) => {
          for (const m of extractForwardable(line)) {
            if (m.role !== "assistant" || !m.text) continue;
            const target = getReplyChat(chat.podId, chat.sessionId) ?? chat.chatId;
            sendChatMessage(target, prefix, m.text).catch(() => {});
            if (m.uuid) lastUuid = m.uuid;
          }
        },
        (n) => save(chat.podId, chat.sessionId, transcriptPath, n, lastUuid)
      );
    } catch {
      // fall through to backoff
    }
    if (t.stopped) break;
    await sleep(backoff + Math.floor(Math.random() * 500));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

// Fresh session: cursor created at offset 0 by SessionStart → forward from the first message.
// Compaction/rotation shrank the file (offset past EOF) → skip to the new end; we don't replay
// (the post-compaction summary isn't conversational), and live tailing resumes from there.
function initOffset(podId: string, sessionId: string, transcriptPath: string, size: number): number {
  const cur = getTranscriptCursor(podId, sessionId);
  if (cur.byteOffset > size) {
    save(podId, sessionId, transcriptPath, size, cur.lastUuid);
    return size;
  }
  return cur.byteOffset;
}

function save(podId: string, sessionId: string, transcriptPath: string, byteOffset: number, lastUuid: string | null): void {
  setTranscriptCursor(podId, sessionId, { transcriptPath, byteOffset, lastUuid });
}

async function fileSize(target: PodTarget, transcriptPath: string): Promise<number> {
  try {
    const res = await target.exec(["sh", "-c", 'wc -c < "$1" 2>/dev/null || echo 0', "sh", transcriptPath]);
    return parseInt(res.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function key(podId: string, sessionId: string): string {
  return `${podId}:${sessionId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
