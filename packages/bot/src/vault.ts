import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

const VAULT_DIR = paths.vault;

function masterKey(): Buffer | null {
  const b64 = process.env.PAIRPOD_VAULT_KEY;
  if (!b64) return null;
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("PAIRPOD_VAULT_KEY must decode to 32 bytes (base64)");
  }
  return key;
}

export function vaultEnabled(): boolean {
  return masterKey() !== null;
}

function refPath(ref: string): string {
  return path.join(VAULT_DIR, `${ref}.json`);
}

export function vaultPut(plaintext: string): string {
  const key = masterKey();
  if (!key) throw new Error("vault disabled (PAIRPOD_VAULT_KEY unset)");
  const ref = crypto.randomUUID();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const entry = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(refPath(ref), JSON.stringify(entry), { mode: 0o600 });
  return ref;
}

export function vaultGet(ref: string): string {
  const key = masterKey();
  if (!key) throw new Error("vault disabled (PAIRPOD_VAULT_KEY unset)");
  const entry = JSON.parse(fs.readFileSync(refPath(ref), "utf8")) as {
    iv: string;
    tag: string;
    data: string;
  };
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function vaultRemove(ref: string): void {
  try {
    fs.rmSync(refPath(ref));
  } catch {}
}
