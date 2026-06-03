import type { FastifyInstance } from "fastify";
import { validateInitData } from "./telegram-auth.js";
import { isOwner } from "./access.js";
import { botConfig } from "./config.js";
import { createSshPod, updateSshPod, getSshEndpoint, type SshFields } from "./store.js";
import { vaultEnabled } from "./vault.js";
import type { SshAuth } from "./targets/ssh.js";

interface SshBody {
  label?: string;
  host?: string;
  port?: string | number;
  username?: string;
  remoteCwd?: string;
  auth?: string;
  keyPath?: string;
  privateKey?: string;
  passphrase?: string;
  tgData?: string;
}

// SSH endpoints carry vault-backed secrets and define new pods — owner-only.
function authed(tgData: string | undefined): boolean {
  const auth = validateInitData(tgData ?? "", botConfig.token, botConfig.authMaxAgeSec);
  return auth.ok && isOwner(auth.userId, auth.username);
}

function parseFields(b: SshBody): { fields: SshFields } | { error: string } {
  const host = (b.host ?? "").trim();
  const username = (b.username ?? "").trim();
  const method = (b.auth ?? "") as SshAuth;
  if (!host || !username) return { error: "host and username are required" };
  if (method !== "agent" && method !== "key_path" && method !== "vault") {
    return { error: "invalid auth method" };
  }
  if (method === "vault" && b.privateKey && !vaultEnabled()) {
    return { error: "vault disabled (PAIRPOD_VAULT_KEY unset)" };
  }
  return {
    fields: {
      label: (b.label ?? "").trim() || undefined,
      host,
      port: Number(b.port) || 22,
      username,
      remoteCwd: (b.remoteCwd ?? "").trim() || "~",
      auth: method,
      keyPath: method === "key_path" ? (b.keyPath ?? "").trim() : undefined,
      privateKey: method === "vault" ? b.privateKey || undefined : undefined,
      passphrase:
        method === "vault" || method === "key_path" ? (b.passphrase ?? "") || undefined : undefined,
    },
  };
}

export async function sshRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ssh/config", async (_req, reply) => {
    return reply.send({ vaultEnabled: vaultEnabled() });
  });

  app.get("/ssh/endpoints/:id", async (req, reply) => {
    const q = req.query as { tgData?: string };
    if (!authed(q.tgData)) return reply.status(403).send({ ok: false, error: "unauthorized" });
    const ep = getSshEndpoint((req.params as { id: string }).id);
    if (!ep) return reply.status(404).send({ ok: false, error: "not found" });
    return reply.send({ ok: true, endpoint: ep });
  });

  app.post("/ssh/endpoints", async (req, reply) => {
    const b = (req.body || {}) as SshBody;
    if (!authed(b.tgData)) return reply.status(403).send({ ok: false, error: "unauthorized" });
    const parsed = parseFields(b);
    if ("error" in parsed) return reply.status(400).send({ ok: false, error: parsed.error });
    if (parsed.fields.auth === "vault" && !parsed.fields.privateKey) {
      return reply.status(400).send({ ok: false, error: "paste a private key" });
    }
    try {
      const id = await createSshPod(parsed.fields);
      return reply.send({ ok: true, id });
    } catch (e) {
      return reply.status(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.put("/ssh/endpoints/:id", async (req, reply) => {
    const b = (req.body || {}) as SshBody;
    if (!authed(b.tgData)) return reply.status(403).send({ ok: false, error: "unauthorized" });
    const parsed = parseFields(b);
    if ("error" in parsed) return reply.status(400).send({ ok: false, error: parsed.error });
    try {
      const id = (req.params as { id: string }).id;
      await updateSshPod(id, parsed.fields);
      return reply.send({ ok: true, id });
    } catch (e) {
      return reply.status(400).send({ ok: false, error: (e as Error).message });
    }
  });
}
