const path = require("node:path");
const { readJson, writeJson } = require("./config-store");

// 聊天历史落盘：user-data/chat-history.json
// 结构：{ version: 1, characters: { [characterId]: [{ role: "user"|"assistant", content, ts }] } }
// 设计取舍：
// - 按角色分开存（切换角色/模型时各自有上下文，不会串味）；
// - JSON + 同步读写：桌宠消息量小（历史上限 20~2000），没必要引入 SQLite；
// - 写入前做裁剪，文件不会无限增长。
const HISTORY_VERSION = 1;
const DEFAULT_LIMIT = 300;
const MAX_CONTENT_LENGTH = 4000;

function normalizeCharacterId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id || "default";
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const role = entry.role === "user" || entry.role === "assistant" || entry.role === "system"
    ? entry.role
    : "";
  let content = typeof entry.content === "string" ? entry.content.trim() : "";
  if (!role || !content) return null;
  if (content.length > MAX_CONTENT_LENGTH) content = content.slice(0, MAX_CONTENT_LENGTH);
  const ts = Number(entry.ts);
  return { role, content, ts: Number.isFinite(ts) && ts > 0 ? Math.round(ts) : Date.now() };
}

function emptyHistory() {
  return { version: HISTORY_VERSION, characters: {} };
}

function createChatHistoryStore(userDataDir) {
  const dir = path.resolve(String(userDataDir || "."));
  const file = path.join(dir, "chat-history.json");

  function readAll() {
    const raw = readJson(file, null);
    if (!raw || typeof raw !== "object" || !raw.characters || typeof raw.characters !== "object") {
      return emptyHistory();
    }
    const characters = {};
    for (const [key, list] of Object.entries(raw.characters)) {
      if (!Array.isArray(list)) continue;
      const entries = list.map(normalizeEntry).filter(Boolean);
      if (entries.length) characters[normalizeCharacterId(key)] = entries;
    }
    return { version: HISTORY_VERSION, characters };
  }

  function saveAll(data) {
    writeJson(file, data);
    return data;
  }

  function load(characterId) {
    const id = normalizeCharacterId(characterId);
    const data = readAll();
    return (data.characters[id] || []).map((entry) => ({ ...entry }));
  }

  /**
   * 追加一条消息。limit 是保留条数（默认 DEFAULT_LIMIT，取 20~2000）。
   * 返回该角色裁剪后的完整历史，便于渲染进程直接重绘。
   */
  function append(characterId, entry, options) {
    const id = normalizeCharacterId(characterId);
    const normalized = normalizeEntry(entry);
    if (!normalized) return load(id);
    const limit = Math.min(2000, Math.max(20, Number(options && options.limit) || DEFAULT_LIMIT));
    const data = readAll();
    const list = data.characters[id] || [];
    list.push(normalized);
    // 只保留最近 limit 条（按时间顺序尾部截取）
    data.characters[id] = list.length > limit ? list.slice(list.length - limit) : list;
    saveAll(data);
    return data.characters[id].map((item) => ({ ...item }));
  }

  /** clear() 清空全部角色；clear(id) 只清空该角色。返回清理后的统计。 */
  function clear(characterId) {
    const data = readAll();
    if (characterId === undefined || characterId === null || characterId === "") {
      data.characters = {};
    } else {
      delete data.characters[normalizeCharacterId(characterId)];
    }
    saveAll(data);
    return stats(data);
  }

  function stats(data) {
    const source = data || readAll();
    let messages = 0;
    for (const list of Object.values(source.characters)) messages += list.length;
    return {
      file,
      characters: Object.keys(source.characters).length,
      messages
    };
  }

  return { file, load, append, clear, stats, readAll };
}

module.exports = {
  DEFAULT_LIMIT,
  HISTORY_VERSION,
  MAX_CONTENT_LENGTH,
  createChatHistoryStore,
  normalizeCharacterId,
  normalizeEntry
};
