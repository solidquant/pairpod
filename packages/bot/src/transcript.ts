export type EventKind = "permission" | "idle" | "auth" | "start" | "other";

export interface ToolRef {
  name: string;
  input: Record<string, unknown>;
}

export interface SpoolEvent {
  ts: number;
  kind: EventKind;
  pod: string;
  session: string;
  tool?: ToolRef;
  transcriptPath?: string;
  message?: string;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function parseSpoolLine(line: string): SpoolEvent | null {
  const o = parseLine(line.trim());
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  if (typeof e.kind !== "string" || typeof e.ts !== "number") return null;
  return e as unknown as SpoolEvent;
}

// The tool Claude is currently blocked on: the last tool_use whose id never gets
// a matching tool_result in the same transcript. Ignores subagent (isSidechain) turns.
export function findPendingToolUse(jsonl: string): ToolRef | null {
  const resultIds = new Set<string>();
  const toolUses: { id?: string; tool: ToolRef }[] = [];

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    const o = parseLine(raw) as Record<string, unknown> | undefined;
    if (!o || o.isSidechain) continue;
    const content = (o.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b?.type === "tool_use" && typeof b.name === "string") {
        toolUses.push({
          id: typeof b.id === "string" ? b.id : undefined,
          tool: { name: b.name, input: (b.input as Record<string, unknown>) ?? {} },
        });
      } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        resultIds.add(b.tool_use_id);
      }
    }
  }

  for (let i = toolUses.length - 1; i >= 0; i--) {
    const { id, tool } = toolUses[i];
    if (!id || !resultIds.has(id)) return tool;
  }
  return null;
}

export interface ForwardableMessage {
  role: "user" | "assistant";
  text: string;
  uuid?: string;
  ts?: string;
}

const NOISE_PREFIXES = [
  "Caveat:",
  "[Request interrupted",
  "<local-command-stdout>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
];

function isNoise(text: string): boolean {
  const t = text.trimStart();
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content as Record<string, unknown>[]) {
    if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

// Clean conversational text to forward to Telegram: assistant + real user text only.
// Drops thinking/tool_use/tool_result, subagent (isSidechain) and injected (isMeta) turns,
// and the command/bash/caveat wrappers. sinceUuid resumes just after that entry.
export function extractForwardable(jsonl: string, sinceUuid?: string): ForwardableMessage[] {
  const all: ForwardableMessage[] = [];
  let cutIndex = -1;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    const o = parseLine(raw) as Record<string, unknown> | undefined;
    if (!o || o.isSidechain) continue;
    const type = o.type;
    if (type !== "user" && type !== "assistant") continue;
    if (type === "user" && o.isMeta) continue;

    const uuid = typeof o.uuid === "string" ? o.uuid : undefined;
    const text = textBlocks((o.message as { content?: unknown })?.content).join("\n").trim();
    if (text && !isNoise(text)) {
      all.push({ role: type, text, uuid, ts: typeof o.timestamp === "string" ? o.timestamp : undefined });
    }
    if (sinceUuid && uuid === sinceUuid) cutIndex = all.length;
  }

  return sinceUuid && cutIndex >= 0 ? all.slice(cutIndex) : all;
}

function clip(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export function describeTool(tool: ToolRef): string {
  const { name, input } = tool;
  const pick = (k: string): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;

  const arg =
    pick("file_path") ??
    pick("command") ??
    pick("path") ??
    pick("url") ??
    pick("pattern") ??
    pick("query");

  return arg ? `${name}: ${clip(arg)}` : name;
}
