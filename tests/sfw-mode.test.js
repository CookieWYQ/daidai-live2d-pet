const assert = require("node:assert");
const test = require("node:test");
const { effectiveNsfw, resolveNsfwOverride, sfwState } = require("../src/main/sfw-mode");

test("SFW 是默认：配置里没有 nsfwMode 时生效为 SFW 毛玻璃", () => {
  assert.equal(effectiveNsfw({}, null), false);
  assert.equal(effectiveNsfw({ nsfwMode: false }, null), false);
  assert.equal(effectiveNsfw({ nsfwMode: "true" }, null), false);
  assert.equal(effectiveNsfw({ nsfwMode: true }, null), true);
});

test("启动参数 --nsfw / --sfw 强制对应模式", () => {
  assert.equal(resolveNsfwOverride({ argv: ["--nsfw"], env: {} }), true);
  assert.equal(resolveNsfwOverride({ argv: ["--sfw"], env: {} }), false);
  assert.equal(resolveNsfwOverride({ argv: [], env: {} }), null);
});

test("环境变量 DAIDAI_NSFW / DAIDAI_SFW 强制对应模式", () => {
  assert.equal(resolveNsfwOverride({ argv: [], env: { DAIDAI_NSFW: "1" } }), true);
  assert.equal(resolveNsfwOverride({ argv: [], env: { DAIDAI_NSFW: "true" } }), true);
  assert.equal(resolveNsfwOverride({ argv: [], env: { DAIDAI_NSFW: "0" } }), false);
  assert.equal(resolveNsfwOverride({ argv: [], env: { DAIDAI_SFW: "1" } }), false);
  assert.equal(resolveNsfwOverride({ argv: [], env: { DAIDAI_NSFW: "" } }), null);
  // 命令行优先于环境变量
  assert.equal(resolveNsfwOverride({ argv: ["--sfw"], env: { DAIDAI_NSFW: "1" } }), false);
});

test("强制模式覆盖已保存选择但保留 savedNsfw，便于测试后恢复", () => {
  const config = { nsfwMode: false, sfwBlur: 22 };
  const forced = sfwState(config, true);
  assert.equal(forced.nsfw, true);
  assert.equal(forced.sfw, false);
  assert.equal(forced.forced, true);
  assert.equal(forced.savedNsfw, false);

  const normal = sfwState(config, null);
  assert.equal(normal.sfw, true);
  assert.equal(normal.nsfw, false);
  assert.equal(normal.forced, null);
});

test("模糊强度被限制在 8-72px，默认 42（SFW 强模糊）", () => {
  assert.equal(sfwState({ sfwBlur: 100 }, null).blur, 72);
  assert.equal(sfwState({ sfwBlur: 1 }, null).blur, 8);
  assert.equal(sfwState({}, null).blur, 42);
});
