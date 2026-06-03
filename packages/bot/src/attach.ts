import type { FastifyInstance } from "fastify";
import { getDb } from "./db.js";
import { wireAttach } from "./routes/attach.js";
import { validateInitData } from "./telegram-auth.js";
import { effectiveRole } from "./access.js";
import { canWrite } from "./roles.js";
import { botConfig } from "./config.js";
import { getPodRow } from "./store.js";
import { targetForPod } from "./targets/index.js";
import { attachLocal } from "./local/sessions.js";
import { markActive, markInactive } from "./active-sessions.js";
import { addViewer, removeViewer } from "./viewers.js";

interface AttachQuery {
  pod?: string;
  session?: string;
  cols?: string;
  rows?: string;
  tgData?: string;
}

export async function attachRoutes(app: FastifyInstance): Promise<void> {
  // The mini app asks whether this user may write to the pod, to declutter the read-only UI.
  // (Server-side enforcement still happens on /attach and /upload regardless of this answer.)
  app.get("/access", async (req, reply) => {
    const q = req.query as { pod?: string; tgData?: string };
    const auth = validateInitData(q.tgData ?? "", botConfig.token, botConfig.authMaxAgeSec);
    if (!auth.ok || !q.pod) return reply.code(403).send({ ok: false });
    const role = effectiveRole(auth.userId, auth.username, q.pod);
    if (role === null) return reply.code(403).send({ ok: false });
    return reply.send({ ok: true, write: canWrite(role) });
  });

  app.get("/attach", { websocket: true }, async (socket, req) => {
    const q = req.query as AttachQuery;

    const auth = validateInitData(q.tgData ?? "", botConfig.token, botConfig.authMaxAgeSec);
    if (!auth.ok) {
      req.log.warn({ reason: auth.reason }, "miniapp attach unauthorized");
      socket.close(4003, "unauthorized");
      return;
    }

    const podId = q.pod;
    const sessionId = q.session;
    if (!podId || !sessionId) {
      socket.close(4004, "missing pod/session");
      return;
    }

    const role = effectiveRole(auth.userId, auth.username, podId);
    if (role === null) {
      req.log.warn({ userId: auth.userId, username: auth.username, podId }, "miniapp attach forbidden pod");
      socket.close(4003, "forbidden");
      return;
    }
    const readonly = !canWrite(role);

    const pod = getPodRow(podId);
    if (!pod) {
      socket.close(4004, "pod not found");
      return;
    }
    const session = getDb()
      .prepare("SELECT id FROM sessions WHERE pod_id = ? AND id = ?")
      .get(podId, sessionId);
    if (!session) {
      socket.close(4004, "session not found");
      return;
    }

    // While this socket is open the user is watching the terminal; suppress its notifications.
    markActive(podId, sessionId);
    const viewerKey = `${podId}:${sessionId}`;
    addViewer(viewerKey, socket);
    socket.on("close", () => {
      markInactive(podId, sessionId);
      removeViewer(viewerKey, socket);
    });

    if (pod.kind === "local") {
      if (!botConfig.hostMode) {
        req.log.warn("host attach rejected (host mode disabled)");
        socket.close(4003, "host mode disabled");
        return;
      }
      const cols = q.cols ? parseInt(q.cols, 10) : 80;
      const rows = q.rows ? parseInt(q.rows, 10) : 24;
      attachLocal(socket, sessionId, cols, rows, readonly);
      return;
    }

    const target = targetForPod(pod);

    if (pod.kind === "ssh") {
      try {
        const has = await target.exec(["tmux", "has-session", "-t", sessionId]);
        if (has.exitCode !== 0) {
          socket.close(4004, "session not found");
          return;
        }
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, "ssh has-session check failed");
        socket.close(4500, "ssh connect failed");
        return;
      }
    }

    // Server-global; ensures sessions created before this setting also share by smallest client.
    await target.exec(["tmux", "set", "-g", "window-size", "smallest"]).catch(() => {});

    await wireAttach(
      socket,
      { cols: q.cols, rows: q.rows },
      target,
      sessionId,
      (msg, extra) => req.log.info({ extra }, msg),
      readonly
    );
  });
}
