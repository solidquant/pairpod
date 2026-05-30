import type { Duplex } from "node:stream";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PtySession {
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void> | void;
}

export interface PodTarget {
  exec(cmd: string[]): Promise<ExecResult>;
  openPty(cmd: string[], cols: number, rows: number): Promise<PtySession>;
  dispose?(): Promise<void>;
}
