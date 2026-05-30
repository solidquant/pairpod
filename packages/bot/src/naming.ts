import { getDb } from "./db.js";

function nextCounter(name: string): number {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)").run(name);
  const row = db
    .prepare("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value")
    .get(name) as { value: number };
  return row.value;
}

export function nextPodId(): string {
  return `pod-${nextCounter("pods")}`;
}

export function nextSessionId(podId: string): string {
  return `claude-${nextCounter(`sessions:${podId}`)}`;
}

export function nextTerminalId(podId: string): string {
  return `terminal-${nextCounter(`terminals:${podId}`)}`;
}
