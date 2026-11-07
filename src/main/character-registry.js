// 角色注册表：角色（一张角色卡提示词）→ 模型（一个角色可对应多个模型/场景）→ 动作。
// 基础数据随应用发布（config/characters.json），用户编辑的提示词写入 user-data/characters.json，
// 只覆盖提示词等可编辑字段，不破坏内置模型映射。纯逻辑模块，便于单元测试。
const fs = require("node:fs");
const path = require("node:path");

const CHARACTERS_FILE = path.join(__dirname, "..", "..", "config", "characters.json");
// 用户覆盖文件与 scene-catalog 的用户文件同目录（Electron userData）
const USER_CHARACTERS_FILE = "characters.json";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toArray(value, mapper) {
  if (!Array.isArray(value)) return [];
  return value.map(mapper || ((item) => String(item))).filter((item) => item !== "");
}

function normalizeCharacter(raw, id) {
  const source = raw && typeof raw === "object" ? raw : {};
  const characterId = String(source.id || id || "").trim();
  const games = toArray(source.games).concat(source.game ? [String(source.game)].filter(Boolean) : []);
  return {
    id: characterId,
    name: String(source.name || characterId).trim(),
    aliases: toArray(source.aliases),
    game: String(source.game || "").trim(),
    games: [...new Set(games.map((game) => String(game).trim()).filter(Boolean))],
    bundle: String(source.bundle || "").trim(),
    modelIds: [...new Set(toArray(source.modelIds))],
    nsfwSource: source.nsfwSource === true,
    userTitle: String(source.userTitle || "").trim(),
    prompt: String(source.prompt || "").trim(),
    personality: toArray(source.personality),
    evidence: Array.isArray(source.evidence) ? source.evidence : [],
    confidence: String(source.confidence || "unknown"),
    // 角色卡是否被用户改过（决定 payload 里 overridden 标记）
    promptSource: "seed"
  };
}

function charactersFromConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const characters = {};
  const list = Array.isArray(source.characters)
    ? source.characters
    : source.characters && typeof source.characters === "object"
      ? Object.entries(source.characters).map(([id, entry]) => ({ ...(entry || {}), id }))
      : [];
  for (const item of list) {
    const character = normalizeCharacter(item, item && item.id);
    if (!character.id) continue;
    characters[character.id] = character;
  }
  return {
    version: Number(source.version) || 1,
    description: String(source.description || ""),
    generatedAt: source.generatedAt || null,
    characters
  };
}

function buildIndexes(characters) {
  const byModel = {};
  const byGame = {};
  const duplicateModelIds = [];
  for (const character of Object.values(characters)) {
    for (const modelId of character.modelIds) {
      if (byModel[modelId] && byModel[modelId] !== character.id) {
        duplicateModelIds.push({ modelId, characters: [byModel[modelId], character.id] });
        continue;
      }
      byModel[modelId] = character.id;
    }
    // 同一游戏有多个角色时，先到先得；显式 modelIds 优先（游戏兜底只用于新导入/未映射模型）
    for (const game of character.games) {
      if (!byGame[game]) byGame[game] = character.id;
    }
  }
  return { byModel, byGame, duplicateModelIds };
}

function loadCharacters(options) {
  const opts = options || {};
  const baseFile = opts.baseFile || CHARACTERS_FILE;
  const userDataDir = opts.userDataDir || "";
  const baseRaw = readJson(baseFile, null);
  const userFile = userDataDir ? path.join(userDataDir, USER_CHARACTERS_FILE) : "";
  const userRaw = userFile ? readJson(userFile, null) : null;

  const base = charactersFromConfig(baseRaw);
  const user = charactersFromConfig(userRaw);
  const characters = {};
  // 顺序：内置角色在前，用户新增角色在后，保证 UI 顺序稳定
  for (const [id, character] of Object.entries(base.characters)) {
    characters[id] = { ...character };
  }
  for (const [id, character] of Object.entries(user.characters)) {
    const builtin = characters[id];
    if (builtin) {
      // 用户覆盖：只允许改文案/身份字段，模型映射以用户提供的为准（允许手工修正）
      characters[id] = {
        ...builtin,
        name: character.name && character.name !== id ? character.name : builtin.name,
        game: character.game || builtin.game,
        games: character.games.length ? character.games : builtin.games,
        bundle: character.bundle || builtin.bundle,
        modelIds: character.modelIds.length ? character.modelIds : builtin.modelIds,
        nsfwSource: character.nsfwSource === true ? true : builtin.nsfwSource,
        userTitle: character.userTitle || builtin.userTitle,
        prompt: character.prompt || builtin.prompt,
        personality: character.personality.length ? character.personality : builtin.personality,
        evidence: character.evidence.length ? character.evidence : builtin.evidence,
        confidence: character.confidence !== "unknown" ? character.confidence : builtin.confidence,
        promptSource: character.prompt ? "user" : "seed"
      };
    } else {
      characters[id] = { ...character, promptSource: character.prompt ? "user" : "seed" };
    }
  }

  const index = buildIndexes(characters);
  const stats = {
    characters: Object.keys(characters).length,
    modelsCovered: Object.keys(index.byModel).length,
    games: new Set(Object.values(characters).flatMap((character) => character.games)).size,
    overriddenPrompts: Object.values(characters).filter((character) => character.promptSource === "user").length
  };
  return {
    filePath: baseFile,
    userFile: userRaw ? userFile : "",
    error: baseRaw ? null : "characters.json 读取失败",
    registry: {
      version: base.version,
      description: base.description,
      generatedAt: base.generatedAt,
      loadedAt: new Date().toISOString(),
      filePath: baseFile,
      userFile: userRaw ? userFile : "",
      characters,
      byModel: index.byModel,
      byGame: index.byGame,
      duplicateModelIds: index.duplicateModelIds,
      stats
    }
  };
}

// 模型 → 角色：先按显式 modelIds，再按游戏名兜底（新导入模型也能沿用同游戏角色）
function characterForModel(registry, model) {
  if (!registry || !model || !registry.characters) return null;
  const id = String(model.id || "").trim();
  if (id && registry.byModel[id]) return registry.characters[registry.byModel[id]] || null;
  const game = String(model.game || "").trim();
  if (game && registry.byGame[game]) return registry.characters[registry.byGame[game]] || null;
  return null;
}

// 当前生效的角色卡：角色自带提示词优先；没有角色时回退到「通用兜底角色卡」(config.tavern.rolePrompt)
function resolveCharacterPrompt(registry, model, fallbackPrompt) {
  const character = characterForModel(registry, model);
  const prompt = character && character.prompt ? character.prompt : String(fallbackPrompt || "").trim();
  return {
    character: character || null,
    characterId: character ? character.id : "",
    prompt,
    source: character && character.prompt ? character.promptSource : "fallback",
    overridden: Boolean(character && character.prompt && character.promptSource === "user")
  };
}

// 覆盖审计：seed 角色映射是否覆盖全部模型、是否重复分配
function auditCharacterCoverage(registry, models) {
  const list = models || [];
  const report = { total: list.length, covered: 0, missing: [], duplicates: [], unknownCharacters: [] };
  const seen = new Set();
  for (const model of list) {
    const character = characterForModel(registry, model);
    if (!character) {
      report.missing.push(model.id);
      continue;
    }
    report.covered += 1;
    if (seen.has(model.id)) report.duplicates.push(model.id);
    seen.add(model.id);
  }
  if (registry && Array.isArray(registry.duplicateModelIds)) {
    for (const duplicate of registry.duplicateModelIds) report.duplicates.push(duplicate.modelId);
  }
  report.characterCount = registry && registry.stats ? registry.stats.characters : 0;
  return report;
}

// 管理页/payload 用：角色列表 + 模型/游戏索引 + 当前模型对应角色
function buildCharactersPayload(registry, currentModel) {
  if (!registry || !registry.characters) {
    return { characters: [], byModel: {}, byGame: {}, activeCharacterId: "", activeCharacter: null, stats: { characters: 0, modelsCovered: 0 } };
  }
  const active = characterForModel(registry, currentModel);
  return {
    characters: Object.values(registry.characters).map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      game: character.game,
      games: character.games,
      bundle: character.bundle,
      modelIds: character.modelIds,
      nsfwSource: character.nsfwSource,
      userTitle: character.userTitle,
      prompt: character.prompt,
      personality: character.personality,
      promptSource: character.promptSource,
      overridden: character.promptSource === "user",
      confidence: character.confidence
    })),
    byModel: { ...registry.byModel },
    byGame: { ...registry.byGame },
    activeCharacterId: active ? active.id : "",
    activeCharacter: active ? { id: active.id, name: active.name, prompt: active.prompt } : null,
    stats: registry.stats
  };
}

// 保存/清除用户角色卡提示词；prompt 为空或 null 表示删除覆盖、回退内置提示词
function saveCharacterPrompt(options) {
  const opts = options || {};
  const characterId = String(opts.characterId || "").trim();
  if (!characterId) return { ok: false, error: "缺少角色 id" };
  const userDataDir = opts.userDataDir || "";
  if (!userDataDir) return { ok: false, error: "缺少用户数据目录" };
  const file = path.join(userDataDir, USER_CHARACTERS_FILE);
  const raw = readJson(file, null) || { version: 1, description: "用户角色卡覆盖：只保存被修改的提示词", characters: {} };
  const source = raw && typeof raw === "object" ? raw : {};
  const characters = source.characters && typeof source.characters === "object" && !Array.isArray(source.characters)
    ? { ...source.characters }
    : {};
  const prompt = opts.prompt === null || opts.prompt === undefined ? "" : String(opts.prompt).trim();
  if (prompt) {
    characters[characterId] = {
      ...(characters[characterId] || {}),
      prompt,
      updatedAt: new Date().toISOString()
    };
  } else if (characters[characterId]) {
    delete characters[characterId].prompt;
    delete characters[characterId].updatedAt;
    if (Object.keys(characters[characterId]).length === 0) delete characters[characterId];
  }
  const next = { ...source, version: Number(source.version) || 1, characters };
  writeJson(file, next);
  return { ok: true, file, characterId, cleared: !prompt };
}

module.exports = {
  CHARACTERS_FILE,
  USER_CHARACTERS_FILE,
  normalizeCharacter,
  charactersFromConfig,
  loadCharacters,
  characterForModel,
  resolveCharacterPrompt,
  auditCharacterCoverage,
  buildCharactersPayload,
  saveCharacterPrompt
};
