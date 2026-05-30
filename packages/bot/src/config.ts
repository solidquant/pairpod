import { z } from "zod";
import crypto from "node:crypto";
import { paths } from "./paths.js";

const EnvSchema = z.object({
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  LOG_LEVEL: z.string().default("info"),
  PAIRPOD_NETWORK: z.string().default("pairpod-net"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
});

const parsed = EnvSchema.parse(process.env);

export const config = {
  workspacesRoot: paths.workspaces,
  dbPath: paths.db,
  dockerSocket: parsed.DOCKER_SOCKET,
  logLevel: parsed.LOG_LEVEL,
  pairpodNetwork: parsed.PAIRPOD_NETWORK,
  telegramAllowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS
    ? parsed.TELEGRAM_ALLOWED_USER_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : [],
};

const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const miniappUrl = (process.env.MINIAPP_URL ?? "").replace(/\/$/, "");

export const botConfig = {
  token,
  hookToken: token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 32) : "",
  miniappUrl,
  // Public origin a remote (SSH) host POSTs permission notifications to. Defaults to the
  // mini-app origin; set PAIRPOD_PUBLIC_URL to decouple it (e.g. a stable named tunnel).
  publicUrl: ((process.env.PAIRPOD_PUBLIC_URL ?? "").replace(/\/$/, "")) || miniappUrl,
  port: Number(process.env.PORT ?? 40002),
  allowedUserIds: config.telegramAllowedUserIds,
  allowedUsernames: (process.env.TELEGRAM_ALLOWED_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean),
  authMaxAgeSec: Number(process.env.MINIAPP_AUTH_MAX_AGE_SEC ?? 86400),
};
