export type EventKind = "permission" | "idle" | "auth" | "other";

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
