const assert = require("node:assert");
const test = require("node:test");
const { createStatusBridge, normalizeEvent } = require("../src/main/status-bridge");

test("normalizeEvent maps common agent events", () => {
  assert.equal(normalizeEvent("thinking"), "thinking");
  assert.equal(normalizeEvent("running-tool"), "tool_use");
  assert.equal(normalizeEvent("completed"), "complete");
});

test("status bridge tracks per-agent session state", () => {
  const bridge = createStatusBridge();
  bridge.updateState("claude-code", "thinking", {
    session_id: "claude-1",
    summary: "Claude 正在思考"
  });
  bridge.updateState("codex", "complete", {
    session_id: "codex-1",
    reply_text: "Codex 最后一条回复"
  });

  const status = bridge.getStatus();
  assert.equal(status.sessions.length, 2);
  assert.equal(status.sessions.find((item) => item.sessionId === "claude-1").agent, "claude");
  assert.equal(status.sessions.find((item) => item.sessionId === "codex-1").replyText, "Codex 最后一条回复");
});
