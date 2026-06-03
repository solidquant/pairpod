import type { FastifyInstance } from "fastify";
import { getDb } from "./db.js";
import { validateInitData } from "./telegram-auth.js";
import { effectiveRole } from "./access.js";
import { canWrite } from "./roles.js";
import { botConfig } from "./config.js";
import { getPodRow } from "./store.js";
import { sniffImage, hashName } from "./media-ingest.js";
import { writeToPod } from "./media-transport.js";

const MAX = 21 * 1024 * 1024;
const TYPES = ["application/octet-stream", "image/png", "image/jpeg", "image/webp", "image/gif"];

interface UploadQuery {
  pod?: string;
  session?: string;
  tgData?: string;
}

// Image upload from the mini app: raw image bytes in the body (no multipart dep). The
// content-type parser is encapsulated to this plugin, so only /upload buffers binary. We
// just place the file on the pod and return its path — the mini app stages it and injects
// the [image: …] reference itself on the next send, so the user can type a message with it.
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(TYPES, { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post("/upload", { bodyLimit: MAX }, async (req, reply) => {
    const q = req.query as UploadQuery;
    const auth = validateInitData(q.tgData ?? "", botConfig.token, botConfig.authMaxAgeSec);
    if (!auth.ok) return reply.code(403).send({ error: "forbidden" });
    const podId = q.pod;
    const sessionId = q.session;
    if (!podId || !sessionId) return reply.code(400).send({ error: "missing pod/session" });
    if (!canWrite(effectiveRole(auth.userId, auth.username, podId))) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const pod = getPodRow(podId);
    if (!pod) return reply.code(404).send({ error: "pod not found" });
    const exists = getDb()
      .prepare("SELECT 1 FROM sessions WHERE pod_id = ? AND id = ?")
      .get(podId, sessionId);
    if (!exists) return reply.code(404).send({ error: "session not found" });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "empty body" });
    const kind = sniffImage(body);
    if (!kind) return reply.code(415).send({ error: "only PNG/JPG/WebP/GIF" });

    try {
      const podPath = await writeToPod(pod, sessionId, hashName(body, kind.ext), body);
      return reply.send({ ok: true, path: podPath });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
}
