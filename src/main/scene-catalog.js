// 场景目录（scene-catalog）：每个模型 = 一个可切换的「场景」，带给 AI 的描述/调用时机/NSFW 限制/证据。
// 纯逻辑模块：加载、按模型查找、校验、启动默认模型回退、注入 AI 提示词。
const fs = require("node:fs");
const path = require("node:path");

const CATALOG_FILE = path.join(__dirname, "..", "..", "config", "scene-catalog.json");
const USER_CATALOG_FILE = "scene-catalog.json";
const REQUIRED_FIELDS = ["modelId", "group", "kind", "sceneLabel", "category", "description", "whenToUse", "nsfwOnly", "evidence"];
const KINDS = ["character", "auxiliary", "prop", "expression"];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeEntry(entry, modelId) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  return {
    modelId: String(raw.modelId || modelId || ""),
    modelDirName: String(raw.modelDirName || ""),
    bundle: String(raw.bundle || ""),
    bundleLabel: String(raw.bundleLabel || ""),
    game: String(raw.game || ""),
    character: String(raw.character || raw.game || ""),
    group: String(raw.group || ""),
    kind: KINDS.includes(raw.kind) ? raw.kind : "character",
    sceneLabel: String(raw.sceneLabel || ""),
    category: String(raw.category || "日常"),
    description: String(raw.description || ""),
    whenToUse: String(raw.whenToUse || ""),
    nsfwOnly: Boolean(raw.nsfwOnly),
    keywords,
    defaultScene: String(raw.defaultScene || "idle"),
    representativeMotions: Array.isArray(raw.representativeMotions) ? raw.representativeMotions.map(String) : [],
    soundExamples: Array.isArray(raw.soundExamples) ? raw.soundExamples.map(String) : [],
    display: raw.display && typeof raw.display === "object" ? { scale: raw.display.scale == null ? null : Number(raw.display.scale) } : { scale: null },
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    confidence: String(raw.confidence || "unknown"),
    opaqueFullFrame: Boolean(raw.opaqueFullFrame),
    experimental: Boolean(raw.experimental)
  };
}

function loadSceneCatalog(options) {
  const opts = options || {};
  const baseFile = opts.baseFile || CATALOG_FILE;
  const userDataDir = opts.userDataDir || "";
  const base = readJson(baseFile, null);
  const userFile = userDataDir ? path.join(userDataDir, USER_CATALOG_FILE) : "";
  const user = userFile ? readJson(userFile, null) : null;
  const source = base || { models: {}, games: {}, dirIndex: {} };
  const catalog = {
    version: Number(source.version) || 1,
    description: String(source.description || ""),
    generatedAt: source.generatedAt || null,
    loadedAt: new Date().toISOString(),
    baseFile,
    userFile: user && user.models ? userFile : "",
    models: {},
    dirIndex: {},
    games: {}
  };
  const models = Object.assign({}, source.models || {}, (user && user.models) || {});
  for (const [modelId, entry] of Object.entries(models)) {
    catalog.models[modelId] = normalizeEntry(entry, modelId);
  }
  catalog.dirIndex = Object.assign({}, source.dirIndex || {}, (user && user.dirIndex) || {});
  catalog.stats = (user && user.stats) || source.stats || null;
  for (const [gameKey, game] of Object.entries(Object.assign({}, source.games || {}, (user && user.games) || {}))) {
    catalog.games[gameKey] = Object.assign({ character: "", modelIds: [] }, game);
  }
  return { filePath: baseFile, userFile: catalog.userFile, catalog, error: base ? null : "scene-catalog.json 读取失败" };
}

function entryForModel(catalog, model) {
  if (!catalog || !model) return null;
  if (catalog.models[model.id]) return catalog.models[model.id];
  const bundle = model.bundle || "";
  const game = model.game || "";
  const dirName = model.modelDirName || path.basename(model.directory || "");
  const key = bundle + "|" + game + "|" + dirName;
  const id = catalog.dirIndex[key];
  if (id && catalog.models[id]) return catalog.models[id];
  // 兜底：只按目录名匹配（容忍 game 字符串差异）
  for (const entry of Object.values(catalog.models)) {
    if (entry.modelDirName && entry.modelDirName === dirName) return entry;
  }
  return null;
}

function auditCatalog(catalog, models) {
  const list = models || [];
  const issues = [];
  let covered = 0;
  const kindCounts = {};
  const categories = {};
  const missingModels = [];
  for (const model of list) {
    const entry = entryForModel(catalog, model);
    if (!entry) {
      missingModels.push(model.id);
      issues.push({ modelId: model.id, modelDirName: model.modelDirName, issue: "缺少场景目录条目" });
      continue;
    }
    covered += 1;
    for (const field of REQUIRED_FIELDS) {
      if (field === "nsfwOnly") continue;
      const value = entry[field];
      const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (empty) issues.push({ modelId: model.id, modelDirName: entry.modelDirName, issue: "字段为空: " + field });
    }
    if (!entry.evidence.length) issues.push({ modelId: model.id, issue: "evidence 为空" });
    if (!String(entry.sceneLabel || "").trim()) issues.push({ modelId: model.id, issue: "sceneLabel 为空" });
    kindCounts[entry.kind] = (kindCounts[entry.kind] || 0) + 1;
    categories[entry.category] = (categories[entry.category] || 0) + 1;
  }
  return {
    total: list.length,
    covered,
    missing: list.length - covered,
    missingModels,
    issues,
    kindCounts,
    categories,
    auxiliaryModels: list.filter((m) => {
      const e = entryForModel(catalog, m);
      return e && e.kind === "auxiliary";
    }).map((m) => ({ id: m.id, name: m.name, modelDirName: m.modelDirName, game: m.game }))
  };
}

// 启动默认模型保底：辅助/剖面模型不能作为启动模型（SFW 下永远回退到同游戏立绘）
function resolveStartupModel(catalog, models, options) {
  const opts = options || {};
  const selectedId = opts.selectedModelId || "";
  const sfw = opts.sfw !== false;
  const list = models || [];
  const current = list.find((m) => m.id === selectedId) || null;
  const entry = current ? entryForModel(catalog, current) : null;
  if (!current) return { selectedModelId: "", fallbackApplied: false, reason: "no_model" };
  const isAuxiliary = entry && entry.kind === "auxiliary";
  if (!isAuxiliary || !sfw) {
    return { selectedModelId: current.id, fallbackApplied: false, reason: isAuxiliary ? "auxiliary_allowed_nsfw" : "ok" };
  }
  // 同游戏优先立绘（tachie / 默认模型）
  const sameGame = list.filter((m) => {
    const e = entryForModel(catalog, m);
    return e && e.game === entry.game && e.kind !== "auxiliary" && e.kind === "character";
  });
  const preferred = sameGame.find((m) => /tachie/i.test(m.modelDirName || "")) || sameGame[0];
  if (preferred) {
    return { selectedModelId: preferred.id, fallbackApplied: true, reason: "auxiliary_fallback_same_game", fallbackModel: preferred };
  }
  const anyCharacter = list.find((m) => {
    const e = entryForModel(catalog, m);
    return e && e.kind === "character";
  });
  return { selectedModelId: anyCharacter ? anyCharacter.id : current.id, fallbackApplied: Boolean(anyCharacter), reason: anyCharacter ? "auxiliary_fallback_any_character" : "no_character" };
}

function compactEntryLine(entry) {
  const badges = [];
  if (entry.kind === "auxiliary") badges.push("辅助剖面·非人物");
  if (entry.nsfwOnly) badges.push("NSFW限定");
  if (entry.opaqueFullFrame) badges.push("全屏CG");
  if (entry.experimental) badges.push("实验性");
  return "- " + entry.modelId + "｜" + entry.game + " / " + entry.character + "｜" + entry.sceneLabel +
    (badges.length ? "（" + badges.join("，") + "）" : "") +
    "：" + String(entry.description || "").replace(/\s+/g, " ").slice(0, 180) +
    "；何时用：" + String(entry.whenToUse || "").replace(/\s+/g, " ").slice(0, 120);
}

// AI system prompt 中的场景目录（描述 + 调用时机）；SFW 时明确标注 nsfwOnly 不可用
function buildCatalogPrompt(catalog, options) {
  const opts = options || {};
  if (!catalog || !catalog.models) return "";
  const currentId = opts.currentModelId || "";
  const sfw = opts.sfw !== false;
  const entries = Object.values(catalog.models);
  const current = catalog.models[currentId] || null;
  const sameGame = current ? entries.filter((e) => e.game === current.game && e.modelId !== current.modelId) : [];
  // 其它游戏只给一句概括，避免 prompt 过长；同一游戏给完整描述
  const otherGames = new Map();
  for (const entry of entries) {
    if (entry === current || sameGame.includes(entry)) continue;
    const key = entry.game + "|" + entry.kind;
    if (!otherGames.has(key)) otherGames.set(key, []);
    otherGames.get(key).push(entry);
  }
  const lines = [
    "【场景目录（一个模型 = 一个可切换场景；scene_id 就是下列条目开头的 id，可传给 play_scene 切换）】",
    "规则：只有用户在语义上明确想要某个场景/视角（例：后位、剖面、抱枕、接吻、手交、骑乘位、脱衣）时才切换模型/场景；不要无缘无故换角色或切场景。"
  ];
  if (current) {
    lines.push("当前模型场景：" + compactEntryLine(current));
    if (sfw && current.nsfwOnly) lines.push("注意：当前为 SFW 模式，当前模型属于 NSFW 限定场景，不要主动换装/暴露。");
  }
  if (sameGame.length) {
    lines.push("同游戏其它场景（可按用户要求切换）：");
    sameGame.forEach((entry) => {
      const blocked = sfw && entry.nsfwOnly;
      lines.push(compactEntryLine(entry) + (blocked ? "【当前 SFW 禁用，不要调用；如用户要求请说明需先开启 NSFW】" : ""));
    });
  }
  lines.push("其它游戏的场景目录（只列机器可用的 id 与标签；切换需用户明确指定）：");
  for (const [key, list] of otherGames) {
    lines.push("- " + key.split("|")[0] + "（" + list.length + " 个场景）：" + list.map((e) => e.modelId + "=" + e.sceneLabel + (e.kind === "auxiliary" ? "[辅助]" : "")).join("，"));
  }
  lines.push("辅助剖面模型（kind=auxiliary）只用于「剖面/内部视角」；NSFW 关闭时一律不可用。");
  return lines.join("\n");
}

module.exports = {
  CATALOG_FILE,
  USER_CATALOG_FILE,
  REQUIRED_FIELDS,
  loadSceneCatalog,
  entryForModel,
  auditCatalog,
  resolveStartupModel,
  buildCatalogPrompt,
  compactEntryLine
};
