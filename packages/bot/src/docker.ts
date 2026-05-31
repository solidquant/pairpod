import Dockerode from "dockerode";
import { Writable, Duplex, PassThrough, type Readable } from "node:stream";
import { config } from "./config.js";
import type { AgentDef } from "./agents.js";

let _docker: Dockerode | null = null;

export function getDocker(): Dockerode {
  if (!_docker) {
    _docker = new Dockerode({ socketPath: config.dockerSocket });
  }
  return _docker;
}

export async function createContainer(
  podId: string,
  workspacePath: string,
  agent: AgentDef
): Promise<string> {
  const docker = getDocker();
  const container = await docker.createContainer({
    Image: agent.image,
    name: `pairpod-${podId}`,
    Entrypoint: agent.entrypoint,
    WorkingDir: "/workspace",
    Tty: true,
    OpenStdin: true,
    Env: ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"],
    HostConfig: {
      Binds: [`${workspacePath}:/workspace:rw`],
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.pairpodNetwork]: {},
      },
    },
  });
  await container.start();
  return container.id;
}

export async function removeContainer(containerId: string): Promise<void> {
  const docker = getDocker();
  const container = docker.getContainer(containerId);
  await container.remove({ force: true });
}

export async function attachExec(
  containerName: string,
  cmd: string[],
  cols: number,
  rows: number,
): Promise<{ stream: Duplex; resize: (c: number, r: number) => Promise<void> }> {
  const docker = getDocker();
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"],
  });
  const raw = await new Promise<Duplex>((resolve, reject) => {
    exec.start({ hijack: true, stdin: true }, (err: Error | null, s?: Duplex) => {
      if (err) return reject(err);
      if (!s) return reject(new Error("no stream"));
      resolve(s);
    });
  });
  await exec.resize({ w: cols, h: rows });

  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) { raw.write(chunk, cb); },
    destroy(err, cb) { raw.destroy(); cb(err); },
  });

  // dockerode's hijacked Tty exec stream is stdcopy-framed; strip the 8-byte headers
  // (buffering partial frames across chunks) or the header bytes corrupt the display.
  let buf = Buffer.alloc(0);
  raw.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      duplex.push(buf.subarray(8, 8 + size));
      buf = buf.subarray(8 + size);
    }
  });
  raw.on("end", () => duplex.push(null));
  raw.on("close", () => { if (!duplex.destroyed) duplex.destroy(); });
  raw.on("error", (e) => duplex.destroy(e));

  return {
    stream: duplex,
    resize: (c: number, r: number) => exec.resize({ w: c, h: r }),
  };
}

export async function streamExec(
  containerId: string,
  cmd: string[]
): Promise<{ stream: Readable; close: () => void }> {
  const docker = getDocker();
  const container = docker.getContainer(containerId);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const raw = await new Promise<Duplex>((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err, s) => {
      if (err) return reject(err);
      if (!s) return reject(new Error("No stream from exec"));
      resolve(s as Duplex);
    });
  });
  const out = new PassThrough();
  docker.modem.demuxStream(raw, out, out);
  raw.on("end", () => out.end());
  raw.on("close", () => { if (!out.destroyed) out.destroy(); });
  raw.on("error", (e) => out.destroy(e));
  return { stream: out, close: () => { try { raw.destroy(); } catch {} } };
}

export async function execInContainer(
  containerId: string,
  cmd: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const docker = getDocker();
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err, stream) => {
      if (err) return reject(err);
      if (!stream) return reject(new Error("No stream from exec"));

      let stdout = "";
      let stderr = "";

      const stdoutSink = new Writable({ write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); } });
      const stderrSink = new Writable({ write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); } });

      docker.modem.demuxStream(stream, stdoutSink, stderrSink);

      stream.on("end", async () => {
        try {
          const inspect = await exec.inspect();
          resolve({ stdout, stderr, exitCode: inspect.ExitCode ?? 0 });
        } catch (e) {
          reject(e);
        }
      });

      stream.on("error", reject);
    });
  });
}
