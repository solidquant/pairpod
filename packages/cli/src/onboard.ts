import crypto from "node:crypto";
import * as p from "@clack/prompts";
import { readEnv, writeEnv, ENV_PATH } from "./env.js";

function cancelled(v: unknown): never | void {
  if (p.isCancel(v)) {
    p.cancel("Onboarding aborted.");
    process.exit(0);
  }
}

export async function onboard(): Promise<void> {
  p.intro("pairpod onboard");
  const existing = readEnv();

  p.note(
    "1. Open @BotFather in Telegram (https://t.me/BotFather)\n2. Send /newbot and follow the prompts\n3. Copy the token it gives you",
    "Create a Telegram bot"
  );

  const token = await p.password({
    message: "Telegram bot token",
    validate: (v) => (v && v.includes(":") ? undefined : "Looks off — should look like 123456:AA..."),
  });
  cancelled(token);

  const usernames = await p.text({
    message: "Allowed Telegram @usernames (comma-separated; blank = anyone)",
    placeholder: "alice,bob",
    initialValue: existing.TELEGRAM_ALLOWED_USERNAMES ?? "",
    defaultValue: "",
  });
  cancelled(usernames);

  const port = await p.text({
    message: "Port for the bot/mini-app server",
    initialValue: existing.PORT ?? "40002",
    validate: (v) => (/^\d+$/.test(v) ? undefined : "Must be a number"),
  });
  cancelled(port);

  p.note(
    "Host pods open an UNSANDBOXED shell on this machine — full access to its files,\nprocesses, and any keys it holds. Docker and SSH pods are isolated; Host is not.\nLeave this off unless you specifically need a shell on the bot host itself.",
    "⚠ Host mode"
  );
  const hostMode = await p.confirm({
    message: "Enable Host mode (unsandboxed shell on the bot machine)?",
    initialValue: existing.HOST_MODE === "true",
  });
  cancelled(hostMode);

  const hadKey = Boolean(existing.PAIRPOD_VAULT_KEY);
  const vaultKey = existing.PAIRPOD_VAULT_KEY || crypto.randomBytes(32).toString("base64");

  const s = p.spinner();
  s.start("Writing config");
  writeEnv({
    TELEGRAM_BOT_TOKEN: token as string,
    TELEGRAM_ALLOWED_USERNAMES: (usernames as string).trim(),
    PORT: port as string,
    PAIRPOD_VAULT_KEY: vaultKey,
    HOST_MODE: hostMode ? "true" : "false",
  });
  s.stop(`Wrote ${ENV_PATH}`);

  p.note(
    `${hadKey ? "Kept existing" : "Generated a new"} vault key (AES-256-GCM, stored in your .env).`,
    "Credential vault"
  );
  p.outro("Done. Start it with:  pairpod start");
}
