import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { agents } from "./agents.js";
import { nextPodId, nextSessionId, nextTerminalId } from "./naming.js";
import { createContainer, removeContainer } from "./docker.js";
import type { PodTarget } from "./targets/types.js";
import { botConfig } from "./config.js";
import { targetForPod, disposeTarget } from "./targets/index.js";
import { SshTarget, type SshAuth } from "./targets/ssh.js";
import { vaultEnabled, vaultPut, vaultRemove } from "./vault.js";
import { createLocalSession, killLocalSession } from "./local/sessions.js";

export type SessionMode = "danger" | "regular" | "terminal";

const POD_COLS =
  "id, container_id, kind, label, status, created_at, ssh_host, ssh_port, ssh_user, ssh_auth, " +
  "ssh_key_path, ssh_vault_ref, host_fingerprint, remote_cwd";

// Node script (runs in the container) for Claude's Notification hook: reads the
// hook payload on stdin, peeks at the transcript for the pending tool_use to
// summarize what Claude is about to do, and POSTs it to bot's /notify.
const NOTIFY_JS = `let d="";
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  let j={};try{j=JSON.parse(d)}catch{}
  const url=process.env.PAIRPOD_NOTIFY_URL;if(!url)return;
  let detail="";
  try{
    const fs=require("fs");
    const lines=fs.readFileSync(j.transcript_path,"utf8").trim().split("\\n");
    for(let i=lines.length-1;i>=0&&i>lines.length-80;i--){
      let m;try{m=JSON.parse(lines[i])}catch(e){continue}
      const c=m&&m.message&&m.message.content;
      if(!Array.isArray(c))continue;
      const tu=c.find(b=>b&&b.type==="tool_use");
      if(tu){
        const ti=tu.input||{};
        detail=tu.name||"tool";
        if(ti.file_path)detail+=": "+ti.file_path;
        else if(ti.command)detail+=": "+String(ti.command).slice(0,200);
        else if(ti.path)detail+=": "+ti.path;
        else if(ti.url)detail+=": "+ti.url;
        else if(ti.pattern)detail+=": "+ti.pattern;
        break;
      }
    }
  }catch(e){}
  const body=JSON.stringify({
    pod:process.env.PAIRPOD_POD||"",
    session:process.env.PAIRPOD_SESSION||"",
    token:process.env.PAIRPOD_TOKEN||"",
    message:j.message||"",
    detail
  });
  const u=new URL(url);const https=u.protocol==="https:";const lib=require(https?"https":"http");
  const req=lib.request({hostname:u.hostname,port:u.port||(https?443:80),path:u.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)},timeout:5000});
  req.on("error",()=>{});req.on("timeout",()=>req.destroy());
  req.write(body);req.end();
});`;

const MERGE_SETTINGS_JS = `const fs=require("fs"),os=require("os"),path=require("path");
const dir=path.join(os.homedir(),".claude");
fs.mkdirSync(dir,{recursive:true});
const f=path.join(dir,"settings.json");
let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
s.hooks=s.hooks||{};
s.hooks.Notification=[{hooks:[{type:"command",command:"node "+path.join(dir,"pairpod-notify.js")}]}];
fs.writeFileSync(f,JSON.stringify(s,null,2));`;

async function setupNotifyHooks(target: PodTarget): Promise<void> {
  await target.exec([
    "sh", "-c",
    `mkdir -p "$HOME/.claude" && cat > "$HOME/.claude/pairpod-notify.js" <<'PP_EOF'\n${NOTIFY_JS}\nPP_EOF`,
  ]);
  await target.exec(["node", "-e", MERGE_SETTINGS_JS]);
}

export interface PodRow {
  id: string;
  container_id: string;
  kind: string;
  label: string | null;
  status: string;
  created_at: string;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  ssh_auth: string | null;
  ssh_key_path: string | null;
  ssh_vault_ref: string | null;
  host_fingerprint: string | null;
  remote_cwd: string | null;
}

export interface SessionRow {
  id: string;
  pod_id: string;
  label: string | null;
  status: string;
  created_at: string;
}

export interface PodView extends PodRow {
  sessions: SessionRow[];
}

export function getPodRow(id: string): PodRow | undefined {
  return getDb()
    .prepare(`SELECT ${POD_COLS} FROM pods WHERE id = ?`)
    .get(id) as PodRow | undefined;
}

export function listPods(): PodView[] {
  const db = getDb();
  const pods = db
    .prepare(`SELECT ${POD_COLS} FROM pods ORDER BY created_at ASC`)
    .all() as PodRow[];
  const sessions = db
    .prepare("SELECT id, pod_id, label, status, created_at FROM sessions ORDER BY created_at ASC")
    .all() as SessionRow[];

  const byPod = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = byPod.get(s.pod_id) ?? [];
    list.push(s);
    byPod.set(s.pod_id, list);
  }

  return pods.map((p) => ({ ...p, sessions: byPod.get(p.id) ?? [] }));
}

export function setPodLabel(id: string, label: string | null): void {
  getDb().prepare("UPDATE pods SET label = ? WHERE id = ?").run(label?.trim() || null, id);
}

export function setSessionLabel(podId: string, sessionId: string, label: string | null): void {
  getDb()
    .prepare("UPDATE sessions SET label = ? WHERE pod_id = ? AND id = ?")
    .run(label?.trim() || null, podId, sessionId);
}

export function getPod(id: string): PodView | undefined {
  return listPods().find((p) => p.id === id);
}

export async function createPod(): Promise<string> {
  const id = nextPodId();
  const workspacePath = path.join(config.workspacesRoot, id);
  await fs.mkdir(workspacePath, { recursive: true });

  const containerId = await createContainer(id, workspacePath, agents.claude);
  getDb()
    .prepare(
      "INSERT INTO pods (id, container_id, agent, workspace_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, containerId, "claude", workspacePath, "running", new Date().toISOString());
  return id;
}

export function createLocalPod(cwd?: string): string {
  const id = nextPodId();
  getDb()
    .prepare(
      `INSERT INTO pods (id, container_id, agent, workspace_path, status, created_at, kind, remote_cwd)
       VALUES (?, '', 'shell', '', 'running', ?, 'local', ?)`
    )
    .run(id, new Date().toISOString(), cwd?.trim() || os.homedir());
  return id;
}

// Host PTYs live only in this process; their DB rows are stale after a restart.
export function pruneLocalSessions(): void {
  getDb()
    .prepare("DELETE FROM sessions WHERE pod_id IN (SELECT id FROM pods WHERE kind = 'local')")
    .run();
}

export interface SshFields {
  label?: string;
  host: string;
  port: number;
  username: string;
  remoteCwd: string;
  auth: SshAuth;
  keyPath?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshEndpointView {
  id: string;
  label: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  remoteCwd: string | null;
  auth: string | null;
  keyPath: string | null;
  hasKey: boolean;
}

export function getSshEndpoint(id: string): SshEndpointView | undefined {
  const p = getPodRow(id);
  if (!p || p.kind !== "ssh") return undefined;
  return {
    id: p.id,
    label: p.label,
    host: p.ssh_host,
    port: p.ssh_port,
    username: p.ssh_user,
    remoteCwd: p.remote_cwd,
    auth: p.ssh_auth,
    keyPath: p.ssh_key_path,
    hasKey: Boolean(p.ssh_vault_ref),
  };
}

// Connect once with the given settings to validate reachability + remote tmux, and
// capture the host-key fingerprint (TOFU). Rolls back a freshly-created vault entry on failure.
async function probeSsh(
  fields: SshFields,
  vaultRef: string | null,
  rollbackVaultRef: string | null
): Promise<string | undefined> {
  let fingerprint: string | undefined;
  const probe = new SshTarget({
    host: fields.host,
    port: fields.port,
    username: fields.username,
    auth: fields.auth,
    keyPath: fields.keyPath,
    vaultRef: vaultRef ?? undefined,
    onFingerprint: (fp) => {
      fingerprint = fp;
    },
  });
  try {
    const res = await probe.exec(["tmux", "-V"]);
    if (res.exitCode !== 0) {
      throw new Error(`tmux not available on remote: ${(res.stderr || res.stdout).trim()}`);
    }
  } catch (e) {
    await probe.dispose();
    if (rollbackVaultRef) vaultRemove(rollbackVaultRef);
    throw e;
  }
  await probe.dispose();
  return fingerprint;
}

// Decide what the vault entry should be for the desired auth state. The entry holds
// {privateKey?, passphrase?}: a pasted key (vault auth) and/or a passphrase for an
// encrypted key (vault or key_path). agent auth stores nothing. On edit, a blank
// secret keeps the existing entry; a new one rotates (old ref returned as `stale`).
function planVaultEntry(
  opts: SshFields,
  existing: PodRow | undefined
): { ref: string | null; created: string | null; stale: string | null } {
  const prev = existing?.ssh_vault_ref ?? null;

  if (opts.auth === "vault") {
    if (opts.privateKey) {
      if (!vaultEnabled()) throw new Error("vault disabled (set PAIRPOD_VAULT_KEY to paste keys)");
      const ref = vaultPut(JSON.stringify({ privateKey: opts.privateKey, passphrase: opts.passphrase }));
      return { ref, created: ref, stale: prev };
    }
    if (!prev) throw new Error("paste a private key");
    return { ref: prev, created: null, stale: null };
  }

  if (opts.auth === "key_path" && opts.passphrase) {
    if (!vaultEnabled()) {
      throw new Error("vault disabled (set PAIRPOD_VAULT_KEY to store a key passphrase)");
    }
    const ref = vaultPut(JSON.stringify({ passphrase: opts.passphrase }));
    return { ref, created: ref, stale: prev };
  }

  if (opts.auth === "key_path") return { ref: prev, created: null, stale: null };

  // agent: no stored secret
  return { ref: null, created: null, stale: prev };
}

export async function createSshPod(opts: SshFields): Promise<string> {
  const id = nextPodId();

  const plan = planVaultEntry(opts, undefined);
  const vaultRef = plan.ref;
  const fingerprint = await probeSsh(opts, vaultRef, plan.created);

  getDb()
    .prepare(
      `INSERT INTO pods
       (id, container_id, agent, workspace_path, status, created_at, kind, label,
        ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path, ssh_vault_ref, host_fingerprint, remote_cwd)
       VALUES (?, '', 'shell', '', 'running', ?, 'ssh', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      new Date().toISOString(),
      opts.label?.trim() || null,
      opts.host,
      opts.port,
      opts.username,
      opts.auth,
      opts.keyPath ?? null,
      vaultRef,
      fingerprint ?? null,
      opts.remoteCwd || "~"
    );
  return id;
}

export async function updateSshPod(id: string, opts: SshFields): Promise<void> {
  const existing = getPodRow(id);
  if (!existing || existing.kind !== "ssh") throw new Error("SSH endpoint not found");

  const plan = planVaultEntry(opts, existing);
  const vaultRef = plan.ref;

  // host-key TOFU re-pins to whatever the (possibly changed) host now presents.
  const fingerprint = await probeSsh(opts, vaultRef, plan.created);

  getDb()
    .prepare(
      `UPDATE pods SET
         label=?, ssh_host=?, ssh_port=?, ssh_user=?, ssh_auth=?,
         ssh_key_path=?, ssh_vault_ref=?, host_fingerprint=?, remote_cwd=?
       WHERE id=?`
    )
    .run(
      opts.label?.trim() || null,
      opts.host,
      opts.port,
      opts.username,
      opts.auth,
      opts.auth === "key_path" ? opts.keyPath ?? null : null,
      vaultRef,
      fingerprint ?? null,
      opts.remoteCwd || "~",
      id
    );

  if (plan.stale && plan.stale !== vaultRef) vaultRemove(plan.stale);
  await disposeTarget(id);
}

export async function testPod(id: string): Promise<string> {
  const pod = getPodRow(id);
  if (!pod) throw new Error("pod not found");
  const res = await targetForPod(pod).exec(["tmux", "-V"]);
  if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim() || `exit ${res.exitCode}`);
  return res.stdout.trim() || "ok";
}

export async function deletePod(id: string): Promise<void> {
  const db = getDb();
  const pod = getPodRow(id);
  if (!pod) return;
  if (pod.kind === "ssh") {
    await disposeTarget(id);
    if (pod.ssh_vault_ref) vaultRemove(pod.ssh_vault_ref);
  } else if (pod.kind === "local") {
    const rows = db.prepare("SELECT id FROM sessions WHERE pod_id = ?").all(id) as { id: string }[];
    for (const r of rows) killLocalSession(r.id);
  } else {
    await removeContainer(pod.container_id);
  }
  db.prepare("DELETE FROM tg_session_state WHERE pod_id = ?").run(id);
  db.prepare("DELETE FROM pods WHERE id = ?").run(id);
}

export async function createSession(podId: string, mode: SessionMode): Promise<string> {
  const db = getDb();
  const pod = getPodRow(podId);
  if (!pod) throw new Error(`Pod ${podId} not found`);

  if (pod.kind === "local") {
    if (mode !== "terminal") throw new Error("Host pods support terminal sessions only");
    const sid = nextTerminalId(podId);
    db.prepare("INSERT INTO sessions (id, pod_id, status, created_at) VALUES (?, ?, ?, ?)").run(
      sid,
      podId,
      "running",
      new Date().toISOString()
    );
    createLocalSession(sid, pod.remote_cwd || os.homedir());
    return sid;
  }

  const target = targetForPod(pod);
  const cwd = pod.kind === "ssh" ? pod.remote_cwd || "~" : "/workspace";

  // Claude on a remote needs a publicly reachable bot for the permission-notify hook
  // and claude itself installed on that host. Resolve its absolute path from a login shell
  // so the launch doesn't depend on tmux's (non-login) PATH.
  let claudeBin = "claude";
  if (mode !== "terminal" && pod.kind === "ssh") {
    if (!botConfig.publicUrl) {
      throw new Error(
        "set MINIAPP_URL (or PAIRPOD_PUBLIC_URL) to run Claude on SSH — needed for permission notifications"
      );
    }
    const probe = await target.exec(["sh", "-lc", "command -v claude"]);
    if (probe.exitCode !== 0) {
      throw new Error("claude not found on the remote host (install it and run `claude` once to log in)");
    }
    claudeBin = probe.stdout.trim() || "claude";
  }

  const sid = mode === "terminal" ? nextTerminalId(podId) : nextSessionId(podId);
  db.prepare("INSERT INTO sessions (id, pod_id, status, created_at) VALUES (?, ?, ?, ?)").run(
    sid,
    podId,
    "running",
    new Date().toISOString()
  );

  // mouse on → wheel/swipe scrolls tmux's own scrollback (copy-mode) for shell
  // panes and forwards to mouse-aware apps like Claude. Applied to fresh servers
  // via the config and to an already-running server via the explicit set below.
  await target.exec([
    "sh", "-c",
    "printf 'set -g mouse on\\nset -g history-limit 50000\\n' > \"$HOME/.tmux.conf\"",
  ]);

  const args = ["tmux", "new-session", "-d", "-s", sid, "-c", cwd];
  if (mode !== "terminal") {
    await setupNotifyHooks(target);
    const notifyUrl =
      pod.kind === "ssh"
        ? `${botConfig.publicUrl}/notify`
        : `http://host.docker.internal:${botConfig.port}/notify`;
    const env =
      `PAIRPOD_POD=${podId} PAIRPOD_SESSION=${sid} ` +
      `PAIRPOD_NOTIFY_URL=${notifyUrl} PAIRPOD_TOKEN=${botConfig.hookToken}`;
    const claude = mode === "danger" ? `${claudeBin} --dangerously-skip-permissions` : claudeBin;
    // On SSH keep an interactive shell after claude exits so a launch failure or login prompt
    // stays visible in the pane instead of the tmux session vanishing (which shows as 4004).
    args.push(pod.kind === "ssh" ? `${env} ${claude}; exec sh -i` : `${env} ${claude}`);
  }
  // terminal: no command → tmux launches the host's default shell
  await target.exec(args);
  await target.exec(["tmux", "set", "-g", "mouse", "on"]);
  return sid;
}

export async function deleteSession(podId: string, sessionId: string): Promise<void> {
  const db = getDb();
  const pod = getPodRow(podId);
  if (pod) {
    if (pod.kind === "local") {
      killLocalSession(sessionId);
    } else {
      try {
        await targetForPod(pod).exec(["tmux", "kill-session", "-t", sessionId]);
      } catch {}
    }
  }
  db.prepare("DELETE FROM sessions WHERE pod_id = ? AND id = ?").run(podId, sessionId);
  db.prepare("DELETE FROM tg_session_state WHERE pod_id = ? AND session_id = ?").run(
    podId,
    sessionId
  );
}
