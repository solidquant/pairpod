import type { Duplex, Readable } from "node:stream";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PtySession {
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void> | void;
}

// A long-lived command (e.g. `tail -F`) whose stdout streams back over the channel
// the target already owns. close() terminates it by tearing down the channel.
export interface ExecStream {
  stream: Readable;
  close(): void;
}

export interface PodTarget {
  exec(cmd: string[]): Promise<ExecResult>;
  execStream(cmd: string[]): Promise<ExecStream>;
  openPty(cmd: string[], cols: number, rows: number): Promise<PtySession>;
  dispose?(): Promise<void>;
}
