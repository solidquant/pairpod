import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Upsert keys into ~/.pairpod/.env, preserving existing ones.
export function updateEnv(vars: Record<string, string>): void {
  let existing: Record<string, string> = {};
  try {
    existing = parseEnv(fs.readFileSync(paths.env, "utf8"));
  } catch {}
  const merged = { ...existing, ...vars };
  const body = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.mkdirSync(path.dirname(paths.env), { recursive: true });
  fs.writeFileSync(paths.env, body + "\n", { mode: 0o600 });
  fs.chmodSync(paths.env, 0o600);
}

// Load ~/.pairpod/.env into process.env without overriding already-set vars,
// so a value injected by the launcher (e.g. a fresh MINIAPP_URL) wins.
export function loadEnv(): void {
  let text = "";
  try {
    text = fs.readFileSync(paths.env, "utf8");
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
