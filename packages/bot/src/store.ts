import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { agents } from "./agents.js";
import { nextPodId, nextSessionId, nextTerminalId } from "./naming.js";
import { createContainer, removeContainer } from "./docker.js";
import type { PodTarget } from "./targets/types.js";
import { targetForPod, disposeTarget } from "./targets/index.js";
import { SshTarget, type SshAuth } from "./targets/ssh.js";
import { vaultEnabled, vaultPut, vaultRemove } from "./vault.js";
import { createLocalSession, killLocalSession } from "./local/sessions.js";

export type SessionMode = "danger" | "regular" | "terminal";

const POD_COLS =
  "id, container_id, kind, label, status, created_at, ssh_host, ssh_port, ssh_user, ssh_auth, " +
  "ssh_key_path, ssh_vault_ref, host_fingerprint, remote_cwd";

// Node script (runs on the target) for Claude's hooks. It is a dumb local writer:
// it appends one structured event to ~/.claude/pairpod-events.jsonl and exits. The
// bot tails that spool over the channel it already owns — no network, no bot address.
// PermissionRequest carries tool_name/tool_input directly; the permission_prompt
// path is a fallback for CLIs without PermissionRequest (a marker file suppresses the
// duplicate) and defers tool description to the bot via transcriptPath.
const NOTIFY_JS = `let d="";
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  let j={};try{j=JSON.parse(d)}catch{}
  const fs=require("fs"),os=require("os"),path=require("path");
  const dir=path.join(os.homedir(),".claude");
  try{fs.mkdirSync(dir,{recursive:true})}catch(e){}
  const spool=path.join(dir,"pairpod-events.jsonl");
  const prMark=path.join(dir,".pairpod-has-pr");
  const ev=j.hook_event_name;
  let out=null;
  if(ev==="PermissionRequest"){
    try{fs.writeFileSync(prMark,"1")}catch(e){}
    out={kind:"permission",tool:{name:j.tool_name||"tool",input:j.tool_input||{}}};
  }else if(ev==="Notification"){
    const nt=j.notification_type;
    if(nt==="idle_prompt")out={kind:"idle"};
    else if(nt==="permission_prompt"&&!fs.existsSync(prMark))out={kind:"permission",transcriptPath:j.transcript_path||""};
  }
  if(!out)return;
  out.ts=Date.now();
  out.pod=process.env.PAIRPOD_POD||"";
  out.session=process.env.PAIRPOD_SESSION||"";
  if(typeof j.message==="string")out.message=j.message;
  try{
    fs.appendFileSync(spool,JSON.stringify(out)+"\\n");
    if(fs.statSync(spool).size>524288){
      const lines=fs.readFileSync(spool,"utf8").split("\\n").filter(Boolean).slice(-200);
      fs.writeFileSync(spool,lines.join("\\n")+"\\n");
    }
  }catch(e){}
});`;

const MERGE_SETTINGS_JS = `const fs=require("fs"),os=require("os"),path=require("path");
const dir=path.join(os.homedir(),".claude");
fs.mkdirSync(dir,{recursive:true});
const f=path.join(dir,"settings.json");
let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
s.hooks=s.hooks||{};
const cmd=[{type:"command",command:"node "+path.join(dir,"pairpod-notify.js")}];
s.hooks.PermissionRequest=[{hooks:cmd}];
s.hooks.Notification=[{hooks:cmd}];
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

// Human-friendly names for notifications: the user-edited label when set, else the raw id.
export function displayNames(podId: string, sessionId: string): { pod: string; session: string } {
  const db = getDb();
  const pod = db.prepare("SELECT label FROM pods WHERE id = ?").get(podId) as
    | { label: string | null }
    | undefined;
  const session = db
    .prepare("SELECT label FROM sessions WHERE pod_id = ? AND id = ?")
    .get(podId, sessionId) as { label: string | null } | undefined;
  return {
    pod: pod?.label?.trim() || podId,
    session: session?.label?.trim() || sessionId,
  };
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

  // Claude on a remote needs claude itself installed on that host. Resolve its absolute
  // path from a login shell so the launch doesn't depend on tmux's (non-login) PATH.
  // Notifications no longer need a public URL: the hook writes to a local spool the bot tails.
  let claudeBin = "claude";
  if (mode !== "terminal" && pod.kind === "ssh") {
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
    const env = `PAIRPOD_POD=${podId} PAIRPOD_SESSION=${sid}`;
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
