import { getDb } from "../db.js";
import { DockerTarget } from "./docker.js";
import type { PodTarget } from "./types.js";
import { SshTarget, type SshAuth } from "./ssh.js";
import type { PodRow } from "../store.js";

const sshPool = new Map<string, SshTarget>();

export function targetForPod(p: PodRow): PodTarget {
  if (p.kind !== "ssh") return new DockerTarget(`pairpod-${p.id}`);
  let target = sshPool.get(p.id);
  if (!target) {
    target = new SshTarget({
      host: p.ssh_host as string,
      port: p.ssh_port ?? 22,
      username: p.ssh_user as string,
      auth: p.ssh_auth as SshAuth,
      keyPath: p.ssh_key_path ?? undefined,
      vaultRef: p.ssh_vault_ref ?? undefined,
      hostFingerprint: p.host_fingerprint ?? undefined,
      onFingerprint: (fp) => {
        getDb().prepare("UPDATE pods SET host_fingerprint = ? WHERE id = ?").run(fp, p.id);
      },
    });
    sshPool.set(p.id, target);
  }
  return target;
}

export async function disposeTarget(podId: string): Promise<void> {
  const target = sshPool.get(podId);
  if (target) {
    await target.dispose();
    sshPool.delete(podId);
  }
}
