import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { readEnv } from "./env.js";

const require = createRequire(import.meta.url);

function resolveBotEntry(): { cmd: string; args: string[] } {
  const botDir = path.dirname(require.resolve("pairpod-bot/package.json"));
  const distMain = path.join(botDir, "dist", "main.js");
  if (fs.existsSync(distMain)) return { cmd: process.execPath, args: [distMain] };
  return { cmd: "npx", args: ["tsx", path.join(botDir, "src", "main.ts")] };
}

function startTunnel(port: string): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    const scan = (buf: Buffer) => {
      const m = String(buf).match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true;
        resolve({ url: m[0], child: cf });
      }
    };
    cf.stdout?.on("data", scan);
    cf.stderr?.on("data", scan);
    cf.on("error", (e) => {
      if (!done) {
        done = true;
        reject(new Error(`could not run cloudflared (${e.message}). Install it: brew install cloudflared`));
      }
    });
    cf.on("exit", (code) => {
      if (!done) {
        done = true;
        reject(new Error(`cloudflared exited (code ${code}) before producing a URL`));
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("timed out waiting for the tunnel URL"));
      }
    }, 30000);
  });
}

export async function start(useTunnel: boolean): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...readEnv() };
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("Not configured yet. Run:  pairpod onboard");
    process.exit(1);
  }
  const port = env.PORT || "40002";

  const children: ChildProcess[] = [];
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) {
      try {
        c.kill();
      } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (useTunnel) {
    process.stdout.write("Starting tunnel… ");
    try {
      const { url, child } = await startTunnel(port);
      children.push(child);
      env.MINIAPP_URL = url;
      console.log(url);
    } catch (e) {
      console.log("failed");
      console.error(`  ${(e as Error).message}`);
      console.error("  Continuing without a tunnel — mini-app buttons will be disabled.");
    }
  }

  const entry = resolveBotEntry();
  const bot = spawn(entry.cmd, entry.args, { env, stdio: "inherit" });
  children.push(bot);
  bot.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`bot exited (code ${code ?? "?"})`);
      shutdown();
    }
  });
}
