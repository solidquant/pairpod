import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PAIRPOD_HOME = process.env.PAIRPOD_HOME
  ? path.resolve(process.env.PAIRPOD_HOME)
  : path.join(os.homedir(), ".pairpod");

export const ENV_PATH = path.join(PAIRPOD_HOME, ".env");

export function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

// Write the given keys, preserving any other existing ones. Empty values are dropped.
export function writeEnv(vars: Record<string, string | undefined>): void {
  fs.mkdirSync(PAIRPOD_HOME, { recursive: true });
  const merged = { ...readEnv(), ...vars };
  const body = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(ENV_PATH, body + "\n", { mode: 0o600 });
}
