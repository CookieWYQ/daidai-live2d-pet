const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CHARACTERS_FILE,
  loadCharacters,
  characterForModel,
  resolveCharacterPrompt,
  auditCharacterCoverage,
  saveCharacterPrompt
} = require("../src/main/character-registry");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "daidai-characters-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

const BASE = {
  version: 1,
  characters: [
    {
      id: "koharu",
      name: "桜森こはる",
      game: "初冬暖阳R",
      games: ["初冬暖阳R"],
      bundle: "tyrano",
      modelIds: ["tachie-ani", "lib-tyrano-120nbqr"],
      prompt: "你是こはる。",
      personality: ["温柔"],
      evidence: [{ source: "test", detail: "fixture" }],
      nsfwSource: true,
      userTitle: "老公"
    },
    {
      id: "hina",
      name: "Hina",
      game: "風紀委員長の裏仕事",
      modelIds: ["lib-ffhouse-1wlg13f"],
      prompt: "你是Hina。"
    }
  ]
};

test("loadCharacters：模型先按显式 modelIds 映射，再按游戏名兜底", () => {
  const dir = tempDir();
  const baseFile = path.join(dir, "characters.json");
  writeJson(baseFile, BASE);
  const { registry, error } = loadCharacters({ baseFile, userDataDir: "" });
  assert.equal(error, null);
  assert.equal(registry.stats.characters, 2);
  assert.equal(registry.stats.modelsCovered, 3);
  assert.equal(characterForModel(registry, { id: "tachie-ani" }).id, "koharu");
  // 未显式列出的同游戏新模型也能兜底到该角色
  assert.equal(characterForModel(registry, { id: "new-model", game: "初冬暖阳R" }).id, "koharu");
  // 没有匹配角色/游戏的模型返回 null（聊天回退到通用兜底角色卡）
  assert.equal(characterForModel(registry, { id: "unknown" }), null);
});

test("用户覆盖提示词：user-data/characters.json 只覆盖 prompt，不破坏内置映射", () => {
  const dir = tempDir();
  const baseFile = path.join(dir, "characters.json");
  writeJson(baseFile, BASE);
  // userDataDir 与 baseFile 分开，避免 base 被用户文件覆盖
  const userDataDir = tempDir();
  writeJson(path.join(userDataDir, "characters.json"), {
    version: 1,
    characters: { koharu: { prompt: "你是用户改过的こはる。" } }
  });
  const { registry } = loadCharacters({ baseFile, userDataDir });
  const koharu = registry.characters.koharu;
  assert.equal(koharu.prompt, "你是用户改过的こはる。");
  assert.equal(koharu.promptSource, "user");
  assert.deepEqual(koharu.modelIds, BASE.characters[0].modelIds);
  const resolved = resolveCharacterPrompt(registry, { id: "tachie-ani" }, "兜底");
  assert.equal(resolved.source, "user");
  assert.equal(resolved.overridden, true);
  assert.equal(resolved.prompt, "你是用户改过的こはる。");
});

test("resolveCharacterPrompt：无角色时回退通用兜底角色卡", () => {
  const dir = tempDir();
  const baseFile = path.join(dir, "characters.json");
  writeJson(baseFile, BASE);
  const { registry } = loadCharacters({ baseFile, userDataDir: "" });
  const resolved = resolveCharacterPrompt(registry, { id: "custom-imported" }, "你是呆呆。");
  assert.equal(resolved.character, null);
  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.prompt, "你是呆呆。");
});

test("saveCharacterPrompt：写入用户覆盖文件，clear 后回退内置提示词", () => {
  const dir = tempDir();
  const baseFile = path.join(dir, "characters.json");
  writeJson(baseFile, BASE);
  const userDataDir = tempDir();
  const saved = saveCharacterPrompt({ userDataDir, characterId: "hina", prompt: "你是改过的Hina。" });
  assert.equal(saved.ok, true);
  let loaded = loadCharacters({ baseFile, userDataDir });
  assert.equal(loaded.registry.characters.hina.prompt, "你是改过的Hina。");
  assert.equal(loaded.registry.characters.hina.promptSource, "user");
  // 清除覆盖 → 回到内置提示词（不删内置角色）
  const cleared = saveCharacterPrompt({ userDataDir, characterId: "hina", prompt: "" });
  assert.equal(cleared.ok, true);
  loaded = loadCharacters({ baseFile, userDataDir });
  assert.equal(loaded.registry.characters.hina.prompt, BASE.characters[1].prompt);
  assert.equal(loaded.registry.characters.hina.promptSource, "seed");
});

test("auditCharacterCoverage：报告未覆盖模型与重复分配", () => {
  const dir = tempDir();
  const baseFile = path.join(dir, "characters.json");
  writeJson(baseFile, {
    version: 1,
    characters: [
      { id: "a", name: "A", modelIds: ["m1", "m2"], prompt: "A" },
      { id: "b", name: "B", modelIds: ["m2", "m3"], prompt: "B" }
    ]
  });
  const { registry } = loadCharacters({ baseFile, userDataDir: "" });
  const audit = auditCharacterCoverage(registry, [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }]);
  assert.equal(audit.covered, 3);
  assert.deepEqual(audit.missing, ["m4"]);
  assert.ok(audit.duplicates.includes("m2"));
});

test("内置 characters.json：全部 63 个模型都有角色，提示词非空且不重复", () => {
  const { registry, error } = loadCharacters({ baseFile: CHARACTERS_FILE, userDataDir: "" });
  assert.equal(error, null);
  assert.ok(registry.stats.characters >= 10, `角色数过少：${registry.stats.characters}`);
  const catalog = require("../config/scene-catalog.json");
  const models = Object.keys(catalog.models).map((id) => ({ id, game: catalog.models[id].game }));
  const audit = auditCharacterCoverage(registry, models);
  assert.equal(audit.total, 63);
  assert.equal(audit.covered, 63, `未覆盖模型：${audit.missing.join(", ")}`);
  assert.equal(audit.missing.length, 0);
  assert.deepEqual(audit.duplicates, []);
  const prompts = new Set();
  for (const character of Object.values(registry.characters)) {
    assert.ok(character.prompt.length >= 80, `${character.id} 提示词过短`);
    assert.ok(!prompts.has(character.prompt), `${character.id} 提示词与其它角色重复`);
    prompts.add(character.prompt);
  }
  assert.equal(registry.stats.overriddenPrompts, 0);
});
