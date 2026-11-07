const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 23334;
const SESSION_TTL = 5 * 60 * 1000;

const STATES = {
  IDLE: "idle",
  THINKING: "thinking",
  TOOL_USE: "tool_use",
  ERROR: "error",
  COMPLETE: "complete",
  NEEDS_ATTENTION: "needs_attention",
  REPLYING: "replying"
};

function normalizeEvent(event) {
  const map = {
    session_start: STATES.IDLE,
    session_end: STATES.IDLE,
    thinking: STATES.THINKING,
    tool_use: STATES.TOOL_USE,
    "running-tool": STATES.TOOL_USE,
    tool_result: STATES.TOOL_USE,
    error: STATES.ERROR,
    complete: STATES.COMPLETE,
    completed: STATES.COMPLETE,
    permission_request: STATES.NEEDS_ATTENTION,
    needs_attention: STATES.NEEDS_ATTENTION,
    waiting_permission: STATES.NEEDS_ATTENTION,
    replying: STATES.REPLYING
  };
  return map[event] || map[String(event || "").toLowerCase()] || STATES.IDLE;
}

function agentKey(agent) {
  const value = String(agent || "").toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  return value || "codex";
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function createStatusBridge({ port = DEFAULT_PORT, stateDir, onChange } = {}) {
  const sessions = new Map();
  const sseClients = new Set();
  const lastPollTimes = new Map();
  const sessionDir = stateDir || path.join(os.homedir(), ".copiwaifu", "sessions");
  let server = null;
  let pollTimer = null;
  let started = false;
  let url = `http://127.0.0.1:${port}/status`;

  function broadcastStatus() {
    const status = getStatus();
    const message = `data: ${JSON.stringify(status)}\n\n`;
    for (const client of sseClients) client.write(message);
    if (onChange) onChange(status);
  }

  function cleanExpired() {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.timestamp > SESSION_TTL) sessions.delete(sid);
    }
  }

  function getStatus() {
    cleanExpired();
    const now = Date.now();
    const active = Array.from(sessions.entries())
      .map(([sessionId, session]) => ({ ...session, sessionId }))
      .sort((a, b) => b.timestamp - a.timestamp);
    const nonIdle = active.filter((session) => session.state !== STATES.IDLE);
    const merged = nonIdle[0] || active[0] || {
      state: STATES.IDLE,
      agent: null,
      summary: "",
      tool: "",
      sessionId: null,
      timestamp: now,
      replyText: ""
    };

    return {
      sessions: active,
      merged,
      sessionCount: active.length,
      updatedAt: new Date(now).toISOString()
    };
  }

  function updateState(agent, event, data = {}) {
    const source = agentKey(agent || data.agent || data.source);
    const state = normalizeEvent(event || data.event || data.state || data.kind || data.status);
    const sessionId = data.session_id || data.sessionId || data.sid || `${source}-default`;
    const previous = sessions.get(sessionId) || {};
    const replyText =
      data.reply_text ||
      data.replyText ||
      data.text ||
      (state === STATES.COMPLETE || state === STATES.IDLE ? previous.replyText : "") ||
      "";
    const summary =
      replyText ||
      data.summary ||
      data.detail ||
      data.label ||
      data.message ||
      previous.summary ||
      "";

    sessions.set(sessionId, {
      state,
      kind: state,
      agent: source,
      source,
      summary,
      text: summary,
      tool: data.tool_name || data.tool || previous.tool || "",
      timestamp: Date.now(),
      replyText
    });

    if (state === STATES.COMPLETE || state === STATES.ERROR) {
      const capturedId = sessionId;
      setTimeout(() => {
        const current = sessions.get(capturedId);
        if (!current || current.state !== state) return;
        sessions.set(capturedId, {
          ...current,
          state: STATES.IDLE,
          kind: STATES.IDLE,
          timestamp: Date.now()
        });
        broadcastStatus();
      }, 8000);
    }

    broadcastStatus();
  }

  function ingestSessionFile(filePath) {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!payload || (!payload.agent && !payload.source)) return;
    const lastEvent = payload.lastEvent || {};
    updateState(payload.agent || payload.source, lastEvent.type || payload.status || payload.state, {
      summary: lastEvent.summary || payload.lastMeaningfulSummary || payload.summary,
      detail: payload.detail,
      tool_name: lastEvent.toolName || payload.toolName || payload.tool,
      session_id: payload.sessionId || payload.session_id || path.basename(filePath, ".json"),
      reply_text: payload.lastMeaningfulSummary || lastEvent.replyText || lastEvent.summary || payload.replyText || ""
    });
  }

  function pollSessionFiles() {
    try {
      if (!fs.existsSync(sessionDir)) return;
      for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = path.join(sessionDir, entry.name);
        const stat = fs.statSync(filePath);
        const last = lastPollTimes.get(entry.name) || 0;
        if (stat.mtimeMs <= last) continue;
        lastPollTimes.set(entry.name, stat.mtimeMs);
        try {
          ingestSessionFile(filePath);
        } catch {}
      }
      cleanExpired();
    } catch {}
  }

  async function handleEvent(req, res) {
    try {
      const body = await readRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const status = payload.state && payload.state.status ? payload.state.status : null;
      if (status) {
        updateState(status.agent || status.source || payload.agent, status.kind || status.state, status);
      } else {
        updateState(payload.agent || payload.source || "codex", payload.event || payload.kind || payload.state, payload.data || payload);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
    }
  }

  function handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && requestUrl.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatus()));
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/event") {
      handleEvent(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  return {
    start() {
      if (started) return;
      server = http.createServer(handleRequest);
      server.on("error", (error) => {
        if (error && error.code === "EADDRINUSE") {
          started = false;
          return;
        }
        throw error;
      });
      server.listen(port, "127.0.0.1", () => {
        started = true;
        pollTimer = setInterval(pollSessionFiles, 1000);
        pollSessionFiles();
      });
    },
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      for (const client of sseClients) client.end();
      sseClients.clear();
      if (server) server.close();
      server = null;
      started = false;
    },
    getStatus,
    getUrl() {
      return url;
    },
    updateState,
    isStarted() {
      return started;
    }
  };
}

module.exports = {
  createStatusBridge,
  normalizeEvent,
  STATES
};
