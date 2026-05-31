import { execInContainer, attachExec, streamExec } from "../docker.js";
import type { PodTarget, ExecResult, ExecStream, PtySession } from "./types.js";

export class DockerTarget implements PodTarget {
  constructor(private readonly ref: string) {}

  exec(cmd: string[]): Promise<ExecResult> {
    return execInContainer(this.ref, cmd);
  }

  execStream(cmd: string[]): Promise<ExecStream> {
    return streamExec(this.ref, cmd);
  }

  openPty(cmd: string[], cols: number, rows: number): Promise<PtySession> {
    return attachExec(this.ref, cmd, cols, rows);
  }
}
