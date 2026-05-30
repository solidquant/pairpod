import fs from "node:fs";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";
import type { PodTarget, ExecResult, PtySession } from "./types.js";
import { vaultGet } from "../vault.js";

export type SshAuth = "agent" | "key_path" | "vault";

export interface SshConnInfo {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  keyPath?: string;
  vaultRef?: string;
  hostFingerprint?: string;
  onFingerprint?: (fingerprint: string) => void;
}

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(cmd: string[]): string {
  return cmd.map(shellQuote).join(" ");
}

function fingerprintOf(hostKey: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
}

export class SshTarget implements PodTarget {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly info: SshConnInfo) {}

  private buildConfig(): ConnectConfig {
    const cfg: ConnectConfig = {
      host: this.info.host,
      port: this.info.port,
      username: this.info.username,
      keepaliveInterval: 15000,
      hostVerifier: (hostKey: Buffer) => {
        const fp = fingerprintOf(hostKey);
        if (this.info.hostFingerprint) return fp === this.info.hostFingerprint;
        this.info.onFingerprint?.(fp);
        return true;
      },
    };
    if (this.info.auth === "agent") {
      cfg.agent = process.env.SSH_AUTH_SOCK;
    } else if (this.info.auth === "key_path") {
      cfg.privateKey = fs.readFileSync(this.info.keyPath as string);
      if (this.info.vaultRef) {
        const secret = JSON.parse(vaultGet(this.info.vaultRef)) as { passphrase?: string };
        if (secret.passphrase) cfg.passphrase = secret.passphrase;
      }
    } else {
      const secret = JSON.parse(vaultGet(this.info.vaultRef as string)) as {
        privateKey: string;
        passphrase?: string;
      };
      cfg.privateKey = secret.privateKey;
      if (secret.passphrase) cfg.passphrase = secret.passphrase;
    }
    return cfg;
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Client>((resolve, reject) => {
      const conn = new Client();
      conn.on("ready", () => {
        this.client = conn;
        resolve(conn);
      });
      conn.on("error", (e) => {
        this.connecting = null;
        reject(e);
      });
      conn.on("close", () => {
        this.client = null;
        this.connecting = null;
      });
      conn.connect(this.buildConfig());
    });
    return this.connecting;
  }

  async exec(cmd: string[]): Promise<ExecResult> {
    const conn = await this.connect();
    return new Promise<ExecResult>((resolve, reject) => {
      conn.exec(shellJoin(cmd), (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
        });
        stream.on("close", (code: number | null) => {
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
        stream.on("error", reject);
      });
    });
  }

  async openPty(cmd: string[], cols: number, rows: number): Promise<PtySession> {
    const conn = await this.connect();
    return new Promise<PtySession>((resolve, reject) => {
      conn.exec(
        shellJoin(cmd),
        { pty: { cols, rows, term: "xterm-256color" } },
        (err, stream) => {
          if (err) return reject(err);
          resolve({
            stream: stream as unknown as Duplex,
            resize: (c: number, r: number) => {
              stream.setWindow(r, c, 0, 0);
            },
          });
        }
      );
    });
  }

  async dispose(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.connecting = null;
  }
}
