import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// All host-specific state lives under one dir. Override with PAIRPOD_HOME.
export const PAIRPOD_HOME = process.env.PAIRPOD_HOME
  ? path.resolve(process.env.PAIRPOD_HOME)
  : path.join(os.homedir(), ".pairpod");

export const paths = {
  home: PAIRPOD_HOME,
  env: path.join(PAIRPOD_HOME, ".env"),
  db: path.join(PAIRPOD_HOME, "pairpod.db"),
  workspaces: path.join(PAIRPOD_HOME, "workspaces"),
  vault: path.join(PAIRPOD_HOME, "vault"),
};

export function ensureHome(): void {
  fs.mkdirSync(PAIRPOD_HOME, { recursive: true });
}
