import type { PodTarget, PtySession } from "../targets/types.js";

export interface AttachSocket {
  readyState: number;
  OPEN: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export async function wireAttach(
  socket: AttachSocket,
  query: { cols?: string; rows?: string },
  target: PodTarget,
  sessionId: string,
  log: (msg: string, extra?: unknown) => void,
): Promise<void> {
  const cols = query.cols ? parseInt(query.cols, 10) : 80;
  const rows = query.rows ? parseInt(query.rows, 10) : 24;

  log(`attach start session=${sessionId} cols=${cols} rows=${rows}`);

  let pty: PtySession;
  try {
    pty = await target.openPty(["tmux", "attach", "-d", "-t", sessionId], cols, rows);
  } catch (e) {
    log("exec failed", e);
    socket.close(4500, "exec failed");
    return;
  }

  const { stream, resize } = pty;

  stream.on("data", (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });

  stream.on("end", () => {
    log("stream ended");
    if (socket.readyState === socket.OPEN) socket.close(1000, "exec ended");
  });

  stream.on("error", (e) => {
    log("stream error", e);
    if (socket.readyState === socket.OPEN) socket.close(1011, "stream error");
  });

  socket.on("message", async (data: Buffer | string) => {
    const raw = typeof data === "string" ? data : data.toString("utf8");
    if (raw.charCodeAt(0) === 0x7b) {
      try {
        const msg = JSON.parse(raw) as { type?: string; cols?: number; rows?: number };
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          await resize(msg.cols, msg.rows);
          return;
        }
      } catch {}
    }
    if (stream.writable) {
      stream.write(typeof data === "string" ? Buffer.from(data) : data);
    }
  });

  socket.on("close", () => {
    stream.destroy();
  });
}
