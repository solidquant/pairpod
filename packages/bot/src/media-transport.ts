import fsp from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.js";
import { listPods, type PodRow } from "./store.js";
import { targetForPod } from "./targets/index.js";

const INBOX = ".pairpod-inbox"; // under a Docker pod's bind-mounted /workspace
const TTL_MS = 5 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const CAP_BYTES = 100 * 1024 * 1024; // per-inbox total; oldest evicted first (LRU)

const sshHome = new Map<string, string>();
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

function dockerInbox(pod: PodRow): string {
  return path.join(pod.workspace_path || path.join(paths.workspaces, pod.id), INBOX);
}

// Write image bytes to a path the pod's Claude can read, returning that absolute pod path.
// Docker: the host workspace is bind-mounted to /workspace. Host: the session shares our fs.
// SSH: sftp into the remote inbox (best-effort TTL cleanup of that dir on the way in).
export async function writeToPod(pod: PodRow, sessionId: string, name: string, data: Buffer): Promise<string> {
  if (pod.kind === "docker") {
    const dir = dockerInbox(pod);
    await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    await fsp.writeFile(path.join(dir, name), data, { mode: 0o644 });
    await enforceCap(dir);
    return `/workspace/${INBOX}/${name}`;
  }
  if (pod.kind === "local") {
    const dir = path.join(paths.media, safe(pod.id), safe(sessionId));
    await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    const p = path.join(dir, name);
    await fsp.writeFile(p, data, { mode: 0o644 });
    await enforceCap(dir);
    return p;
  }
  const target = targetForPod(pod);
  if (!target.putFile) throw new Error("this pod cannot receive files");
  const dir = `${await remoteHome(pod)}/.pairpod/inbox/${safe(sessionId)}`;
  await target.exec(["sh", "-c", `mkdir -p ${shq(dir)}`]);
  const remotePath = `${dir}/${name}`;
  await target.putFile(remotePath, data, 0o644);
  // TTL + byte-cap LRU on the remote inbox (newest-first; drop oldest once over the cap).
  await target.exec(["sh", "-c", sshCleanup(dir)]);
  return remotePath;
}

function sshCleanup(dir: string): string {
  const d = shq(dir);
  return [
    `find ${d} -type f -mmin +${TTL_MS / 60000} -delete 2>/dev/null`,
    `t=0; for f in $(ls -1t ${d} 2>/dev/null); do p=${d}/"$f"; s=$(wc -c < "$p" 2>/dev/null || echo 0); t=$((t+s)); [ "$t" -gt ${CAP_BYTES} ] && rm -f "$p"; done`,
    "true",
  ].join("; ");
}

// Keep an inbox under the byte cap, evicting oldest-by-mtime first.
async function enforceCap(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: { full: string; mtime: number; size: number }[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await fsp.stat(full);
      files.push({ full, mtime: st.mtimeMs, size: st.size });
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  for (const f of files) {
    total += f.size;
    if (total > CAP_BYTES) {
      try {
        await fsp.unlink(f.full);
      } catch {}
    }
  }
}

async function remoteHome(pod: PodRow): Promise<string> {
  const cached = sshHome.get(pod.id);
  if (cached) return cached;
  const res = await targetForPod(pod).exec(["sh", "-c", 'printf %s "$HOME"']);
  const home = res.stdout.trim() || "/root";
  sshHome.set(pod.id, home);
  return home;
}

export function startMediaSweeper(): void {
  sweep().catch(() => {});
  setInterval(() => sweep().catch(() => {}), SWEEP_MS).unref();
}

// TTL-evict host-side inboxes (the local media dir + each Docker pod's workspace inbox). The
// SSH inbox is swept remotely on each write instead.
async function sweep(): Promise<void> {
  const cutoff = Date.now() - TTL_MS;
  await sweepTree(paths.media, cutoff);
  try {
    for (const p of listPods()) {
      if (p.kind === "docker") {
        await sweepTree(dockerInbox(p), cutoff);
      } else if (p.kind === "ssh" && p.status === "running") {
        try {
          await targetForPod(p).exec([
            "sh",
            "-c",
            `find "$HOME/.pairpod/inbox" -type f -mmin +${TTL_MS / 60000} -delete 2>/dev/null || true`,
          ]);
        } catch {}
      }
    }
  } catch {}
}

async function sweepTree(root: string, cutoff: number): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      await sweepTree(full, cutoff);
      continue;
    }
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs < cutoff) await fsp.unlink(full);
    } catch {}
  }
}
