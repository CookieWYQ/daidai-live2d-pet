const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SCAN_INTERVAL_MS = 1000;
const MAX_ACTIVE_FILES = 12;

function defaultSessionsDir() {
  return path.join(os.homedir(), ".codex", "sessions");
}

function sessionIdFromPath(filePath) {
  return path.basename(filePath, ".jsonl");
}

function outputTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return part.text || part.content || "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseToolName(payload) {
  return payload.name || payload.tool || payload.call_id || "";
}

function parseCodexJsonlLine(line, filePath) {
  if (!line || !line.trim()) return null;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }

  if (!record || record.type !== "response_item" || !record.payload) return null;
  const payload = record.payload;
  const sessionId = sessionIdFromPath(filePath);
  const base = {
    agent: "codex",
    session_id: sessionId,
    timestamp: Date.parse(record.timestamp || "") || Date.now()
  };

  if (payload.type === "reasoning") {
    return {
      event: "thinking",
      data: {
        ...base,
        summary: "思考中"
      }
    };
  }

  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const tool = parseToolName(payload);
    return {
      event: "tool_use",
      data: {
        ...base,
        tool_name: tool,
        summary: tool ? `正在调用：${tool}` : "正在运行工具"
      }
    };
  }

  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return {
      event: "tool_use",
      data: {
        ...base,
        summary: "工具返回中"
      }
    };
  }

  if (payload.type === "message" && payload.role === "assistant") {
    const text = outputTextFromContent(payload.content);
    if (!text) return null;
    const phase = String(payload.phase || "");
    return {
      event: phase.includes("final") ? "complete" : "replying",
      data: {
        ...base,
        reply_text: text,
        summary: text
      }
    };
  }

  return null;
}

function walkJsonlFiles(rootDir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(fullPath);
        files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  return files;
}

function discoverRecentFiles(rootDir) {
  return walkJsonlFiles(rootDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_ACTIVE_FILES);
}

function createCodexSessionMonitor({
  rootDir = defaultSessionsDir(),
  onEvent,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  readExisting = false
} = {}) {
  const offsets = new Map();
  const pending = new Map();
  const seenSignatures = new Set();
  let timer = null;
  let initialized = false;

  function emit(event, filePath) {
    if (!event || !onEvent) return;
    const signature = [
      filePath,
      event.event,
      event.data && event.data.timestamp,
      event.data && event.data.reply_text,
      event.data && event.data.tool_name
    ].join("|");
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    onEvent(event);
  }

  function readNewLines(file) {
    let offset = offsets.get(file.filePath);
    if (offset === undefined) {
      const shouldReadFromStart = readExisting || (initialized && Date.now() - file.mtimeMs < 60_000);
      offset = shouldReadFromStart ? 0 : file.size;
      offsets.set(file.filePath, offset);
    }

    if (file.size < offset) offset = 0;
    if (file.size <= offset) return;

    let chunk = "";
    try {
      const fd = fs.openSync(file.filePath, "r");
      const buffer = Buffer.alloc(file.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);
      offsets.set(file.filePath, file.size);
      chunk = buffer.toString("utf8");
    } catch {
      return;
    }

    const current = `${pending.get(file.filePath) || ""}${chunk}`;
    const lines = current.split(/\r?\n/);
    pending.set(file.filePath, lines.pop() || "");
    for (const line of lines) {
      emit(parseCodexJsonlLine(line, file.filePath), file.filePath);
    }
  }

  function scanNow() {
    const files = discoverRecentFiles(rootDir);
    for (const file of files) readNewLines(file);
    initialized = true;
  }

  return {
    start() {
      if (timer) return;
      scanNow();
      timer = setInterval(scanNow, scanIntervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    scanNow
  };
}

module.exports = {
  createCodexSessionMonitor,
  defaultSessionsDir,
  parseCodexJsonlLine
};
