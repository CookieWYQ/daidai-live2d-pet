const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  loadSceneCatalog,
  entryForModel,
  auditCatalog,
  resolveStartupModel,
  buildCatalogPrompt,
  REQUIRED_FIELDS
} = require("../src/main/scene-catalog");

const CATALOG_FILE = path.join(__dirname, "..", "config", "scene-catalog.json");

test("scene-catalog.json 覆盖全部 63 个模型且必填字段完整", () => {
  const { catalog, error } = loadSceneCatalog({ baseFile: CATALOG_FILE, userDataDir: "" });
  assert.equal(error, null);
  assert.equal(Object.keys(catalog.models).length, 63);
  assert.ok(catalog.stats);
  for (const entry of Object.values(catalog.models)) {
    for (const field of REQUIRED_FIELDS) {
      if (field === "nsfwOnly") continue;
      const value = entry[field];
      assert.ok(value !== undefined && value !== null && value !== "", `${entry.modelId} 缺少 ${field}`);
      if (Array.isArray(value)) assert.ok(value.length > 0, `${entry.modelId} ${field} 为空数组`);
    }
    assert.ok(entry.evidence.length > 0, `${entry.modelId} 缺少 evidence`);
    assert.ok(["character", "auxiliary", "prop", "expression"].includes(entry.kind));
  }
});

test("辅助剖面模型（R02_danmen / K_danmen / M01_danmen）标记为 auxiliary 且 NSFW 限定", () => {
  const { catalog } = loadSceneCatalog({ baseFile: CATALOG_FILE, userDataDir: "" });
  const aux = Object.values(catalog.models).filter((entry) => entry.kind === "auxiliary");
  assert.ok(aux.length >= 3);
  for (const entry of aux) {
    assert.equal(entry.nsfwOnly, true);
    assert.ok(entry.sceneLabel.includes("剖面") || entry.sceneLabel.includes("辅助"));
    assert.ok(entry.whenToUse.length > 0);
  }
  assert.ok(aux.some((entry) => entry.modelDirName === "R02_danmen"));
  assert.ok(aux.some((entry) => entry.modelDirName === "K_danmen"));
  assert.ok(aux.some((entry) => entry.modelDirName === "M01_danmen"));
});

test("auditCatalog：63 模型全部有场景条目、无字段缺失", () => {
  const { catalog } = loadSceneCatalog({ baseFile: CATALOG_FILE, userDataDir: "" });
  const models = Object.values(catalog.models).map((entry) => ({
    id: entry.modelId,
    modelDirName: entry.modelDirName,
    bundle: entry.bundle,
    game: entry.game
  }));
  const audit = auditCatalog(catalog, models);
  assert.equal(audit.total, 63);
  assert.equal(audit.covered, 63);
  assert.equal(audit.missing, 0);
  assert.equal(audit.issues.length, 0);
  assert.equal(audit.kindCounts.auxiliary, audit.auxiliaryModels.length);
});

test("启动默认模型保底：SFW 下辅助模型回退到同游戏 character 立绘", () => {
  const { catalog } = loadSceneCatalog({ baseFile: CATALOG_FILE, userDataDir: "" });
  const models = Object.values(catalog.models).map((entry) => ({
    id: entry.modelId,
    name: entry.sceneLabel,
    modelDirName: entry.modelDirName,
    bundle: entry.bundle,
    game: entry.game
  }));
  const aux = Object.values(catalog.models).find((entry) => entry.kind === "auxiliary");
  const resolved = resolveStartupModel(catalog, models, { selectedModelId: aux.modelId, sfw: true });
  assert.equal(resolved.fallbackApplied, true);
  const fallbackEntry = catalog.models[resolved.selectedModelId];
  assert.ok(fallbackEntry);
  assert.equal(fallbackEntry.kind, "character");
  assert.equal(fallbackEntry.game, aux.game);
  // NSFW 下允许辅助模型保持选中
  const nsfwResolved = resolveStartupModel(catalog, models, { selectedModelId: aux.modelId, sfw: false });
  assert.equal(nsfwResolved.fallbackApplied, false);
  assert.equal(nsfwResolved.selectedModelId, aux.modelId);
});

test("场景目录提示词包含描述与何时用，并按 SFW 标注 NSFW 禁用", () => {
  const { catalog } = loadSceneCatalog({ baseFile: CATALOG_FILE, userDataDir: "" });
  const tachie = Object.values(catalog.models).find((entry) => entry.modelDirName === "tachie_ani");
  const prompt = buildCatalogPrompt(catalog, { currentModelId: tachie.modelId, sfw: true });
  assert.ok(prompt.includes("场景目录"));
  assert.ok(prompt.includes("何时用"));
  assert.ok(prompt.includes(tachie.sceneLabel));
  assert.ok(prompt.includes("SFW") || prompt.includes("NSFW"));
  assert.ok(prompt.length > 500);
});
