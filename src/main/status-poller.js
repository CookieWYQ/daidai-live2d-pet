function normalizeStatus(raw) {
  if (!raw || typeof raw !== "object") {
    return { sources: [], updatedAt: new Date().toISOString() };
  }

  if (Array.isArray(raw.sources)) {
    return { ...raw, updatedAt: raw.updatedAt || new Date().toISOString() };
  }

  function normalizedKind(status) {
    const kind = status.state || status.kind || status.status || "idle";
    if (kind === "tool_use") return "running-tool";
    if (kind === "completed") return "complete";
    return kind;
  }

  function sessionText(status) {
    return status.replyText || status.text || status.summary || status.detail || status.label || "";
  }

  function sessionTimestamp(status) {
    const values = [status.timestamp, status.eventTs, status.updatedAt, status.createdAt];
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return Date.now();
  }

  function sourceKey(status) {
    const marker = [
      status.agent,
      status.source,
      status.runtime,
      status.client,
      status.provider,
      status.app,
      status.owner,
      status.sessionId,
      status.session_id
    ].filter(Boolean).join(" ").toLowerCase();
    return marker.includes("claude")
      ? "claude"
      : "codex";
  }

  function isTerminalKind(kind) {
    return kind === "complete" || kind === "completed";
  }

  function isFreshEnough(timestamp, now) {
    // Tiny timestamps are used in unit tests and in some synthetic bridge payloads.
    if (!timestamp || timestamp < 946684800000) return true;
    return now - timestamp <= 45000;
  }

  // 兼容当前成熟宠物 bridge 的 sessions/status 形态。
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  if (sessions.length) {
    const activeBySource = new Map();
    const replyBySource = new Map();
    const now = Date.now();

    for (const session of sessions) {
      const text = sessionText(session);
      if (text === "(Codex 活动中)") continue;

      const source = sourceKey(session);
      const kind = normalizedKind(session);
      const timestamp = sessionTimestamp(session);
      if (!isFreshEnough(timestamp, now)) continue;
      const isReply = isTerminalKind(kind) || (kind === "idle" && text);
      const target = isReply ? replyBySource : activeBySource;
      if (kind === "idle" && !text) continue;

      const previous = target.get(source);
      if (!previous || timestamp > sessionTimestamp(previous)) {
        target.set(source, session);
      }
    }

    const sources = [];
    for (const source of ["codex", "claude"]) {
      const session = activeBySource.get(source) || replyBySource.get(source);
      if (!session) continue;
      const timestamp = sessionTimestamp(session);
      const text = sessionText(session);
      const kind = normalizedKind(session);
      sources.push({
        source,
        kind: kind === "idle" && text ? "complete" : kind,
        text,
        tool: session.tool || "",
        sessionId: session.sessionId || session.session_id || "",
        updatedAt: new Date(timestamp).toISOString(),
        timestamp
      });
    }

    return {
      sources,
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }

  if (raw.kind || raw.status) {
    const status = raw.status && typeof raw.status === "object" ? raw.status : raw;
    return {
      sources: [
          {
          source: sourceKey(status),
          kind: normalizedKind(status),
          text: sessionText(status),
          tool: status.tool || "",
          updatedAt: status.updatedAt || new Date().toISOString()
        }
      ],
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }

  return { sources: [], updatedAt: new Date().toISOString() };
}

function createStatusPoller({ getUrl, onUpdate, intervalMs = 1000, timeoutMs = 1200 }) {
  let timer = null;
  let lastStatus = { sources: [], updatedAt: new Date().toISOString() };

  async function tick() {
    const url = getUrl && getUrl();
    if (!url) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      lastStatus = normalizeStatus(await response.json());
      onUpdate(lastStatus);
    } catch {
      lastStatus = { ...lastStatus, adapterError: true, updatedAt: new Date().toISOString() };
      onUpdate(lastStatus);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      tick();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tickNow() {
      return tick();
    },
    getLastStatus() {
      return lastStatus;
    }
  };
}

module.exports = {
  createStatusPoller,
  normalizeStatus
};
