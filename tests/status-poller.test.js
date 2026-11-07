const assert = require("node:assert");
const test = require("node:test");
const { normalizeStatus } = require("../src/main/status-poller");

test("normalizeStatus maps bridge sessions into codex and claude sources", () => {
  const status = normalizeStatus({
    sessions: [
      {
        state: "thinking",
        agent: "codex",
        summary: "(Codex 活动中)",
        sessionId: "heartbeat",
        timestamp: 1000
      },
      {
        state: "running-tool",
        agent: "codex",
        tool: "shell_command",
        summary: "正在运行命令",
        sessionId: "codex-1",
        timestamp: 2000
      },
      {
        state: "idle",
        agent: "claude",
        replyText: "最后一句回复",
        sessionId: "claude-1",
        timestamp: 3000
      }
    ]
  });

  assert.deepEqual(
    status.sources.map((source) => ({
      source: source.source,
      kind: source.kind,
      text: source.text,
      tool: source.tool
    })),
    [
      {
        source: "codex",
        kind: "running-tool",
        text: "正在运行命令",
        tool: "shell_command"
      },
      {
        source: "claude",
        kind: "complete",
        text: "最后一句回复",
        tool: ""
      }
    ]
  );
});

test("normalizeStatus keeps active work ahead of newer completed replies", () => {
  const status = normalizeStatus({
    sessions: [
      {
        state: "running-tool",
        agent: "codex",
        tool: "shell_command",
        summary: "正在运行命令",
        sessionId: "codex-active",
        timestamp: 2000
      },
      {
        state: "complete",
        agent: "codex",
        replyText: "上一条完成回复",
        sessionId: "codex-complete",
        timestamp: 3000
      }
    ]
  });

  assert.equal(status.sources.length, 1);
  assert.equal(status.sources[0].kind, "running-tool");
  assert.equal(status.sources[0].text, "正在运行命令");
});

test("normalizeStatus can infer claude source from session markers", () => {
  const status = normalizeStatus({
    sessions: [
      {
        state: "thinking",
        sessionId: "claude-code-window-1",
        summary: "Claude 正在思考",
        timestamp: 2000
      }
    ]
  });

  assert.equal(status.sources.length, 1);
  assert.equal(status.sources[0].source, "claude");
  assert.equal(status.sources[0].kind, "thinking");
});
