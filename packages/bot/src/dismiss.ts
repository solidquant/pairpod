import type { FastifyInstance } from "fastify";
import { botConfig } from "./config.js";
import { validateInitData } from "./telegram-auth.js";
import { isAllowed } from "./access.js";
import { dismissNotification } from "./notifier.js";

interface DismissBody {
  cid?: number;
  mid?: number;
  tgData?: string;
}

export async function dismissRoutes(app: FastifyInstance): Promise<void> {
  app.post("/dismiss", async (req, reply) => {
    const b = (req.body || {}) as DismissBody;
    const auth = validateInitData(b.tgData ?? "", botConfig.token, botConfig.authMaxAgeSec);
    if (!auth.ok || !isAllowed(auth.userId, auth.username)) {
      return reply.status(403).send({ ok: false });
    }
    if (typeof b.cid === "number" && typeof b.mid === "number") {
      await dismissNotification(b.cid, b.mid);
    }
    return reply.send({ ok: true });
  });
}
