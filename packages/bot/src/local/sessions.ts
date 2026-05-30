import os from "node:os";
import pty from "node-pty";
import type { IPty } from "node-pty";
import type { AttachSocket } from "../routes/attach.js";

// Host terminals run as node-pty processes held in this process's memory (Route B: no tmux).
// They do not survive a bot restart — pruned from the DB on boot (see pruneLocalSessions).
const MAX_REPLAY = 256 * 1024;

interface LocalSession {
  pty: IPty;
  buffer: Buffer;
  socket: AttachSocket | null;
}

const sessions = new Map<string, LocalSession>();

export function hasLocalSession(id: string): boolean {
  return sessions.has(id);
}

export function createLocalSession(id: string, cwd: string): void {
  if (sessions.has(id)) return;
  const shell = process.env.SHELL || "/bin/bash";
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: process.env as { [key: string]: string },
  });
  const session: LocalSession = { pty: term, buffer: Buffer.alloc(0), socket: null };

  term.onData((d) => {
    const chunk = Buffer.from(d, "utf8");
    session.buffer = Buffer.concat([session.buffer, chunk]);
    if (session.buffer.length > MAX_REPLAY) {
      session.buffer = session.buffer.subarray(session.buffer.length - MAX_REPLAY);
    }
    const s = session.socket;
    if (s && s.readyState === s.OPEN) s.send(chunk);
  });
  term.onExit(() => {
    const s = session.socket;
    if (s && s.readyState === s.OPEN) s.close(1000, "exited");
    sessions.delete(id);
  });

  sessions.set(id, session);
}

export function attachLocal(
  socket: AttachSocket,
  id: string,
  cols: number,
  rows: number
): void {
  const session = sessions.get(id);
  if (!session) {
    socket.close(4004, "session not found");
    return;
  }

  // single viewer: a new attach replaces any existing one
  const prev = session.socket;
  if (prev && prev !== socket && prev.readyState === prev.OPEN) prev.close(1000, "replaced");
  session.socket = socket;

  session.pty.resize(cols, rows);
  if (session.buffer.length && socket.readyState === socket.OPEN) socket.send(session.buffer);

  socket.on("message", (data: Buffer | string) => {
    const raw = typeof data === "string" ? data : data.toString("utf8");
    if (raw.charCodeAt(0) === 0x7b) {
      try {
        const msg = JSON.parse(raw) as { type?: string; cols?: number; rows?: number };
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          session.pty.resize(msg.cols, msg.rows);
          return;
        }
      } catch {}
    }
    session.pty.write(raw);
  });
  socket.on("close", () => {
    if (session.socket === socket) session.socket = null; // detach; keep the pty alive
  });
}

export function killLocalSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.pty.kill();
  } catch {}
  sessions.delete(id);
}
