import type { FastifyInstance } from "fastify";
import { botConfig } from "./config.js";
import { pushNotification } from "./notifier.js";

interface NotifyBody {
  pod?: string;
  session?: string;
  token?: string;
  message?: string;
  detail?: string;
}

export async function notifyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/notify", async (req, reply) => {
    const b = (req.body || {}) as NotifyBody;
    if (!botConfig.hookToken || b.token !== botConfig.hookToken) {
      return reply.status(403).send({ ok: false });
    }
    const label = `${b.pod || "?"}:${b.session || "?"}`;
    let text = `🔔 ${label} needs you`;
    if (b.message) text += `\n${b.message}`;
    if (b.detail) text += `\n↳ ${b.detail}`;
    await pushNotification(text, b.pod, b.session);
    return reply.send({ ok: true });
  });
}
