import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, botConfig } from "./config.js";
import { getDb } from "./db.js";
import { ensureHome } from "./paths.js";
import { ensurePairpodNetwork } from "./network.js";
import { errorHandler } from "./errors.js";
import { attachRoutes } from "./attach.js";
import { notifyRoutes } from "./notify.js";
import { sshRoutes } from "./ssh.js";
import { pruneLocalSessions } from "./store.js";
import { startBot } from "./bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startServer(): Promise<void> {
  ensureHome();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  app.setErrorHandler(errorHandler);

  await app.register(fastifyWebsocket);
  await app.register(attachRoutes);
  await app.register(notifyRoutes);
  await app.register(sshRoutes);

  const miniappDir = path.resolve(__dirname, "../miniapp");
  await app.register(fastifyStatic, {
    root: miniappDir,
    prefix: "/",
    wildcard: true,
    decorateReply: false,
  });

  getDb();
  pruneLocalSessions();
  // Docker is optional: only needed for Docker pods. Don't block startup on it.
  try {
    await ensurePairpodNetwork();
  } catch (e) {
    app.log.warn(`Docker unavailable — Docker pods disabled (${(e as Error).message})`);
  }

  await app.listen({ port: botConfig.port, host: "0.0.0.0" });
  startBot();
}
