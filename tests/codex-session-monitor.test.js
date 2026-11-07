const assert = require("node:assert");
const test = require("node:test");
const path = require("node:path");
const { parseCodexJsonlLine } = require("../src/main/codex-session-monitor");

const filePath = path.join("C:", "tmp", "rollout-test-session.jsonl");

test("parseCodexJsonlLine maps reasoning to thinking", () => {
  const event = parseCodexJsonlLine(
    JSON.stringify({
      timestamp: "2026-06-03T03:30:00.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [] }
    }),
    filePath
  );

  assert.equal(event.event, "thinking");
  assert.equal(event.data.agent, "codex");
  assert.equal(event.data.session_id, "rollout-test-session");
});

test("parseCodexJsonlLine maps function calls to tool use", () => {
  const event = parseCodexJsonlLine(
    JSON.stringify({
      timestamp: "2026-06-03T03:30:00.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "shell_command", call_id: "call-1" }
    }),
    filePath
  );

  assert.equal(event.event, "tool_use");
  assert.equal(event.data.tool_name, "shell_command");
});

test("parseCodexJsonlLine maps final assistant message to complete reply", () => {
  const event = parseCodexJsonlLine(
    JSON.stringify({
      timestamp: "2026-06-03T03:30:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "完成啦，老公。" }]
      }
    }),
    filePath
  );

  assert.equal(event.event, "complete");
  assert.equal(event.data.reply_text, "完成啦，老公。");
});
