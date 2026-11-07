const assert = require("node:assert");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_LIMIT,
  MAX_CONTENT_LENGTH,
  createChatHistoryStore,
  normalizeCharacterId,
  normalizeEntry
} = require("../src/main/chat-history");

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daidai-chat-history-"));
  return { dir, store: createChatHistoryStore(dir) };
}

test("append + load 按角色落盘，重启后仍能读回", () => {
  const { dir, store } = makeStore();
  store.append("imouto", { role: "user", content: "哥哥在吗" });
  store.append("imouto", { role: "assistant", content: "在呀～" });

  // 模拟重启：用同一个 userData 目录重新建 store
  const reopened = createChatHistoryStore(dir);
  const entries = reopened.load("imouto");

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((item) => item.role), ["user", "assistant"]);
  assert.deepEqual(entries.map((item) => item.content), ["哥哥在吗", "在呀～"]);
  assert.ok(entries.every((item) => Number.isFinite(item.ts) && item.ts > 0));
  assert.equal(reopened.stats().messages, 2);
  assert.equal(reopened.stats().characters, 1);
  assert.equal(reopened.file, path.join(dir, "chat-history.json"));
});

test("不同角色分开保存，clear(id) 只清空该角色", () => {
  const { store } = makeStore();
  store.append("a", { role: "user", content: "A1" });
  store.append("b", { role: "user", content: "B1" });

  assert.equal(store.load("a").length, 1);
  assert.equal(store.load("b").length, 1);

  store.clear("a");
  assert.equal(store.load("a").length, 0);
  assert.equal(store.load("b").length, 1);
  assert.equal(store.stats().messages, 1);

  store.append("b", { role: "assistant", content: "B2" });
  store.clear(); // 不带参数 = 清空全部
  assert.equal(store.stats().messages, 0);
  assert.equal(store.stats().characters, 0);
});

test("append 按 limit 截断，且 limit 下限 20、上限 2000", () => {
  const { store } = makeStore();
  for (let i = 1; i <= 25; i += 1) {
    store.append("c", { role: "user", content: `m${i}` }, { limit: 20 });
  }
  const entries = store.load("c");
  assert.equal(entries.length, 20);
  assert.equal(entries[0].content, "m6");
  assert.equal(entries[19].content, "m25");

  // limit 太小 / 非法时按 20 兜底，不会把历史清空
  const capped = store.append("c", { role: "user", content: "last" }, { limit: 1 });
  assert.equal(capped.length, 20);
  assert.equal(capped[capped.length - 1].content, "last");
  assert.equal(DEFAULT_LIMIT, 300);
});

test("normalizeEntry 丢弃非法消息、裁剪首尾空白与超长内容", () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({ role: "tool", content: "x" }), null);
  assert.equal(normalizeEntry({ role: "user", content: "   " }), null);

  const trimmed = normalizeEntry({ role: "user", content: "  hi  " });
  assert.equal(trimmed.content, "hi");

  const long = normalizeEntry({ role: "assistant", content: "x".repeat(MAX_CONTENT_LENGTH + 100) });
  assert.equal(long.content.length, MAX_CONTENT_LENGTH);

  const fixedTs = normalizeEntry({ role: "user", content: "hi", ts: 1234.6 });
  assert.equal(fixedTs.ts, 1235);
  assert.ok(normalizeEntry({ role: "user", content: "hi" }).ts <= Date.now());
});

test("normalizeCharacterId 空值兜底 default", () => {
  assert.equal(normalizeCharacterId(""), "default");
  assert.equal(normalizeCharacterId("   "), "default");
  assert.equal(normalizeCharacterId(null), "default");
  assert.equal(normalizeCharacterId("  imouto  "), "imouto");
});

test("损坏的 chat-history.json 不会抛异常，按空历史处理", () => {
  const { dir, store } = makeStore();
  fs.writeFileSync(path.join(dir, "chat-history.json"), "{ not json", "utf8");
  assert.deepEqual(store.load("x"), []);
  assert.equal(store.stats().messages, 0);
  // 继续写入可以自愈成合法文件
  store.append("x", { role: "user", content: "ok" });
  assert.equal(store.load("x").length, 1);
});
