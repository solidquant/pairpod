import { test } from "node:test";
import assert from "node:assert/strict";
import { findPendingToolUse, describeTool, parseSpoolLine } from "../src/transcript.ts";

const asst = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const result = (toolUseId: string) =>
  JSON.stringify({
    type: "user",
    isSidechain: false,
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  });

test("findPendingToolUse returns the unmatched tool_use", () => {
  const jsonl = [
    asst("toolu_1", "Bash", { command: "pnpm test" }),
    result("toolu_1"),
    asst("toolu_2", "Edit", { file_path: "src/x.ts" }),
  ].join("\n");
  assert.deepEqual(findPendingToolUse(jsonl), { name: "Edit", input: { file_path: "src/x.ts" } });
});

test("findPendingToolUse returns null when all tools have results", () => {
  const jsonl = [asst("toolu_1", "Bash", { command: "ls" }), result("toolu_1")].join("\n");
  assert.equal(findPendingToolUse(jsonl), null);
});

test("findPendingToolUse ignores subagent (sidechain) tool_use", () => {
  const side = JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: { content: [{ type: "tool_use", id: "toolu_side", name: "Grep", input: { pattern: "x" } }] },
  });
  const jsonl = [asst("toolu_1", "Bash", { command: "ls" }), result("toolu_1"), side].join("\n");
  assert.equal(findPendingToolUse(jsonl), null);
});

test("findPendingToolUse tolerates a torn final line and blank lines", () => {
  const jsonl = [asst("toolu_1", "Write", { file_path: "a.ts" }), "", '{"type":"assist'].join("\n");
  assert.deepEqual(findPendingToolUse(jsonl), { name: "Write", input: { file_path: "a.ts" } });
});

test("describeTool summarizes by the most relevant arg", () => {
  assert.equal(describeTool({ name: "Bash", input: { command: "pnpm test" } }), "Bash: pnpm test");
  assert.equal(describeTool({ name: "Edit", input: { file_path: "src/x.ts" } }), "Edit: src/x.ts");
  assert.equal(describeTool({ name: "WebFetch", input: { url: "https://x.dev" } }), "WebFetch: https://x.dev");
  assert.equal(describeTool({ name: "Task", input: {} }), "Task");
});

test("describeTool clips long commands and collapses whitespace", () => {
  const out = describeTool({ name: "Bash", input: { command: "echo " + "a".repeat(300) } });
  assert.ok(out.length <= "Bash: ".length + 200);
  assert.ok(out.endsWith("…"));
});

test("parseSpoolLine accepts a valid event and rejects junk", () => {
  const line = JSON.stringify({ ts: 1, kind: "permission", pod: "p1", session: "s1" });
  assert.deepEqual(parseSpoolLine(line), { ts: 1, kind: "permission", pod: "p1", session: "s1" });
  assert.equal(parseSpoolLine("{not json"), null);
  assert.equal(parseSpoolLine(JSON.stringify({ kind: "idle" })), null);
});
