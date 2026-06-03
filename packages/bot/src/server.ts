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
import { dismissRoutes } from "./dismiss.js";
import { sshRoutes } from "./ssh.js";
import { uploadRoutes } from "./upload.js";
import { pruneLocalSessions } from "./store.js";
import { bootstrapOwners } from "./users.js";
import { startBot } from "./bot.js";
import { startNotifyTailers } from "./notify-tailer.js";
import { startTranscriptTailers } from "./transcript-tailer.js";
import { startMediaSweeper } from "./media-transport.js";

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
  await app.register(dismissRoutes);
  await app.register(sshRoutes);
  await app.register(uploadRoutes);

  // Reap sockets whose TCP connection died silently (e.g. webview suspended on app switch)
  // so they stop holding a stale tmux attach that fights the next viewer.
  type WsClient = typeof app.websocketServer.clients extends Set<infer T> ? T : never;
  const alive = new WeakSet<object>();
  app.websocketServer.on("connection", (socket: WsClient) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of app.websocketServer.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, 30000);
  heartbeat.unref();
  app.addHook("onClose", () => clearInterval(heartbeat));

  const miniappDir = path.resolve(__dirname, "../miniapp");
  await app.register(fastifyStatic, {
    root: miniappDir,
    prefix: "/",
    wildcard: true,
    decorateReply: false,
  });

  getDb();
  bootstrapOwners();
  pruneLocalSessions();
  // Docker is optional: only needed for Docker pods. Don't block startup on it.
  try {
    await ensurePairpodNetwork();
  } catch (e) {
    app.log.warn(`Docker unavailable — Docker pods disabled (${(e as Error).message})`);
  }

  await app.listen({ port: botConfig.port, host: "0.0.0.0" });
  startBot();
  startNotifyTailers();
  startTranscriptTailers();
  startMediaSweeper();
}
