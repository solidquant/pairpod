import { getDb } from "./db.js";
import { listPods, displayNames, type PodRow } from "./store.js";
import { targetForPod } from "./targets/index.js";
import type { PodTarget } from "./targets/types.js";
import { parseSpoolLine, findPendingToolUse, describeTool, type SpoolEvent } from "./transcript.js";
import { consume } from "./spool-stream.js";
import { pushNotification } from "./notifier.js";
import { isActive } from "./active-sessions.js";
import { setTranscriptPath, getChatSession } from "./chat-store.js";
import { kickTranscriptTailers } from "./transcript-tailer.js";

const SPOOL = '"$HOME/.claude/pairpod-events.jsonl"';
const PIDFILE = '"$HOME/.claude/.pairpod-tail.pid"';
const RECONCILE_MS = 10_000;
const IDLE_COLLAPSE_MS = 240_000;
const MAX_BACKOFF_MS = 30_000;

interface Tailer {
  stopped: boolean;
  close?: () => void;
}

const tailers = new Map<string, Tailer>();
const lastIdle = new Map<string, number>();

export function startNotifyTailers(): void {
  reconcile();
  setInterval(reconcile, RECONCILE_MS).unref();
}

function reconcile(): void {
  const pods = listPods().filter((p) => p.kind !== "local" && p.status === "running");
  const live = new Set(pods.map((p) => p.id));

  for (const [id, t] of tailers) {
    if (!live.has(id)) {
      t.stopped = true;
      t.close?.();
      tailers.delete(id);
      for (const k of lastIdle.keys()) if (k.startsWith(`${id}:`)) lastIdle.delete(k);
    }
  }
  for (const p of pods) {
    if (!tailers.has(p.id)) {
      const t: Tailer = { stopped: false };
      tailers.set(p.id, t);
      // If runTailer ever rejects outright, drop the entry so the next reconcile retries.
      runTailer(p, t).catch(() => tailers.delete(p.id));
    }
  }
}

async function runTailer(pod: PodRow, t: Tailer): Promise<void> {
  let backoff = 1_000;
  while (!t.stopped) {
    try {
      const target = targetForPod(pod);
      const size = await spoolSize(target);
      let offset = initOffset(pod.id, size);
      // Kill the previous tail (its pid is in PIDFILE) before starting ours, then record
      // our own pid. This bounds orphans to one even when a client-side socket teardown
      // (Docker) doesn't propagate a signal to the container-side process.
      const cmd = [
        "sh",
        "-c",
        `kill "$(cat ${PIDFILE} 2>/dev/null)" 2>/dev/null; touch ${SPOOL}; ` +
          `echo $$ > ${PIDFILE}; exec tail -c +${offset + 1} -F ${SPOOL} 2>/dev/null`,
      ];
      const { stream, close } = await target.execStream(cmd);
      t.close = close;
      backoff = 1_000;
      offset = await consume(
        stream,
        offset,
        (line) => {
          const ev = parseSpoolLine(line);
          if (ev) handleEvent(pod, target, ev).catch(() => {});
        },
        (n) => saveOffset(pod.id, n)
      );
    } catch {
      // fall through to backoff
    }
    if (t.stopped) break;
    await sleep(backoff + Math.floor(Math.random() * 500));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

async function handleEvent(pod: PodRow, target: PodTarget, ev: SpoolEvent): Promise<void> {
  // SessionStart carries the transcript path; record it so the transcript tailer knows which
  // file to follow for a chat-bridged session. Idempotent, so it bypasses the ts watermark.
  if (ev.kind === "start") {
    if (ev.pod && ev.session && ev.transcriptPath) {
      setTranscriptPath(ev.pod, ev.session, ev.transcriptPath);
      // Only chat sessions are tailed; kick a reconcile so the first reply isn't tick-delayed.
      if (getChatSession(ev.pod, ev.session)) kickTranscriptTailers();
    }
    return;
  }
  // Authoritative dedup: ev.ts is the remote's monotonic clock at hook time. Persisting
  // the high-water mark makes redelivery (reconnect, restart, spool rotation) a no-op.
  if (typeof ev.ts === "number") {
    if (ev.ts <= getLastTs(pod.id)) return;
    setLastTs(pod.id, ev.ts);
  }
  // The user is already watching this session in the mini-app — no need to ping them.
  if (isActive(ev.pod, ev.session)) return;
  const key = `${ev.pod}:${ev.session}`;
  const names = displayNames(ev.pod, ev.session);
  const where = names.pod === names.session ? names.pod : `${names.pod} › ${names.session}`;
  const link = { pod: ev.pod, session: ev.session, buttonLabel: where };

  if (ev.kind === "idle") {
    // Chat-bridged sessions are meant to idle until the next Telegram message — don't ping.
    if (getChatSession(ev.pod, ev.session)) return;
    const now = Date.now();
    if (now - (lastIdle.get(key) ?? 0) < IDLE_COLLAPSE_MS) return;
    lastIdle.set(key, now);
    await pushNotification(`💤 ${where}\nWaiting for your input.`, link);
    return;
  }

  if (ev.kind === "permission") {
    let summary = "";
    if (ev.tool) {
      summary = describeTool(ev.tool);
    } else if (ev.transcriptPath) {
      const pending = await pendingFromRemote(target, ev.transcriptPath);
      if (pending) summary = describeTool(pending);
    }
    lastIdle.delete(key);
    const body = summary ? `Needs permission to run:\n${summary}` : "Needs permission to run a tool.";
    await pushNotification(`🔐 ${where}\n${body}`, link);
  }
}

async function pendingFromRemote(target: PodTarget, transcriptPath: string) {
  try {
    const res = await target.exec(["sh", "-c", 'tail -c 200000 "$1"', "sh", transcriptPath]);
    return res.exitCode === 0 ? findPendingToolUse(res.stdout) : null;
  } catch {
    return null;
  }
}

async function spoolSize(target: PodTarget): Promise<number> {
  try {
    const res = await target.exec(["sh", "-c", `wc -c < ${SPOOL} 2>/dev/null || echo 0`]);
    return parseInt(res.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// Brand-new pod: skip existing history (only notify on events after we start watching).
// Rotation/truncation (cursor past EOF): re-read from the top — the ts watermark in
// handleEvent suppresses the re-emitted history, so this stays correct.
function initOffset(podId: string, size: number): number {
  const row = getDb()
    .prepare("SELECT byte_offset FROM notify_cursor WHERE pod_id = ?")
    .get(podId) as { byte_offset: number } | undefined;
  if (!row) {
    saveOffset(podId, size);
    return size;
  }
  return row.byte_offset > size ? 0 : row.byte_offset;
}

function saveOffset(podId: string, offset: number): void {
  getDb()
    .prepare(
      `INSERT INTO notify_cursor (pod_id, byte_offset, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(pod_id) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at`
    )
    .run(podId, offset, new Date().toISOString());
}

function getLastTs(podId: string): number {
  const row = getDb()
    .prepare("SELECT last_ts FROM notify_cursor WHERE pod_id = ?")
    .get(podId) as { last_ts: number } | undefined;
  return row?.last_ts ?? 0;
}

function setLastTs(podId: string, ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO notify_cursor (pod_id, byte_offset, last_ts, updated_at) VALUES (?, 0, ?, ?)
       ON CONFLICT(pod_id) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at`
    )
    .run(podId, ts, new Date().toISOString());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
