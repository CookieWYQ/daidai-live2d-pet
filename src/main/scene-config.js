// 场景系统（离线可用）——纯逻辑模块，供主进程加载 scenes.json、注入 AI 提示词、解析标签。
// 渲染进程里有对应的轻量匹配逻辑（app.js），这里保持同样的优先级规则：
//   换装/亲密(3) > 情绪(2) > 日常(1)；显式标签优先于关键词；用户消息里的明确指令优先。
const fs = require("node:fs");

const CATEGORY_ORDER = ["换装", "亲密", "情绪", "日常", "实验性", "其他"];
const CATEGORY_PRIORITY = { 换装: 3, 亲密: 3, 情绪: 2, 日常: 1, 实验性: 1, 其他: 1 };
const SCENE_TAG_RE = /[[【]\s*scene\s*[:：]\s*([a-z0-9_-]+)\s*[\]】]/gi;

const DEFAULT_AI = {
  enabled: true,
  tagPrefix: "[scene:",
  tagSuffix: "]",
  cooldownMs: 6000,
  priorityCooldownMs: 15000,
  maxScenesPerReply: 1
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const kw = item.trim().toLowerCase();
    if (kw && !out.includes(kw)) out.push(kw);
  }
  return out;
}

function normalizeMotions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return { name: item.replace(/^motions\//, "").replace(/\.mtn$/, "") };
      if (item && typeof item === "object" && typeof item.name === "string") {
        return {
          name: String(item.name).replace(/^motions\//, "").replace(/\.mtn$/, ""),
          delayMs: num(item.delayMs, 0),
          sound: item.sound
        };
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeParams(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, val] of Object.entries(value)) {
    const n = Number(val);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function normalizeScene(raw, modelId) {
  const category = CATEGORY_ORDER.includes(raw && raw.category) ? raw.category : "其他";
  const scene = {
    id: String((raw && raw.id) || "").trim(),
    label: String((raw && raw.label) || (raw && raw.id) || "").trim(),
    category,
    priority: num(raw && raw.priority, CATEGORY_PRIORITY[category] || 1),
    keywords: normalizeKeywords(raw && raw.keywords),
    motions: normalizeMotions(raw && raw.motions),
    sound: raw && raw.sound !== undefined ? raw.sound : "auto",
    durationMs: num(raw && raw.durationMs, 0),
    transitionMs: num(raw && raw.transitionMs, 900),
    persistent: raw && raw.persistent !== undefined ? Boolean(raw.persistent) : undefined,
    params: normalizeParams(raw && raw.params),
    parts: normalizeParams(raw && raw.parts),
    // 自动生成场景用：随机动作 / 只挑带原声的动作 / 动作名正则过滤
    randomMotion: Boolean(raw && raw.randomMotion),
    linkedOnly: Boolean(raw && raw.linkedOnly),
    motionFilter: raw && typeof raw.motionFilter === "string" ? raw.motionFilter : "",
    // 实验性（启发式半脱）：非原模型素材，默认只能手动触发
    experimental: Boolean(raw && raw.experimental),
    heuristic: Boolean(raw && raw.heuristic),
    heuristicNote: raw && typeof raw.heuristicNote === "string" ? raw.heuristicNote : "",
    // NSFW 限定场景（关闭 SFW 前不可用）
    nsfwOnly: Boolean(raw && raw.nsfwOnly),
    hint: raw && typeof raw.hint === "string" ? raw.hint : "",
    evidence: raw && typeof raw.evidence === "object" ? raw.evidence : null,
    model: modelId
  };
  // 带参数切换的场景（换装）默认保持状态
  if (scene.persistent === undefined) {
    scene.persistent = Object.keys(scene.params).length > 0;
  }
  return scene;
}

function normalizeModelEntry(raw, modelId) {
  const scenes = Array.isArray(raw && raw.scenes)
    ? raw.scenes.map((scene) => normalizeScene(scene, modelId)).filter((scene) => scene.id && scene.label)
    : [];
  const display = raw && raw.display && typeof raw.display === "object" ? raw.display : {};
  const rawAi = raw && raw.aiControl && typeof raw.aiControl === "object" ? raw.aiControl : {};
  const clothing = rawAi.clothing && typeof rawAi.clothing === "object" && rawAi.clothing.param
    ? {
        param: String(rawAi.clothing.param),
        min: num(rawAi.clothing.min, 0),
        max: num(rawAi.clothing.max, 30),
        dressedValue: num(rawAi.clothing.dressedValue, rawAi.clothing.min !== undefined ? rawAi.clothing.min : 0),
        nudeValue: num(rawAi.clothing.nudeValue, rawAi.clothing.max !== undefined ? rawAi.clothing.max : 30),
        note: typeof rawAi.clothing.note === "string" ? rawAi.clothing.note : ""
      }
    : null;
  const accessories = Array.isArray(rawAi.accessories)
    ? rawAi.accessories
        .filter((item) => item && item.id)
        .map((item) => ({
          id: String(item.id),
          label: String(item.label || item.id),
          onMotion: item.onMotion ? String(item.onMotion) : "",
          offMotion: item.offMotion ? String(item.offMotion) : "",
          onParams: normalizeParams(item.onParams),
          offParams: normalizeParams(item.offParams)
        }))
    : [];
  // 每模型显示/部件配置：scale 与 hiddenParts（数字=部件索引，字符串=Cubism3 部件 id）
  const hiddenParts = Array.isArray(raw && raw.hiddenParts)
    ? raw.hiddenParts
        .map((item) => {
          if (typeof item === "number" && Number.isFinite(item)) return item;
          if (typeof item === "string" && item.trim()) {
            return /^\d+$/.test(item.trim()) ? Number(item.trim()) : item.trim();
          }
          return null;
        })
        .filter((item) => item !== null)
    : [];
  // Cubism3/4 背景不是独立部件时，用 drawable 索引隐藏
  const hiddenDrawables = Array.isArray(raw && raw.hiddenDrawables)
    ? raw.hiddenDrawables.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0)
    : [];
  return {
    id: modelId,
    displayName: String((raw && raw.displayName) || modelId),
    display: {
      scale: display.scale === undefined || display.scale === null ? null : num(display.scale, null)
    },
    hiddenParts,
    hiddenDrawables,
    capabilities: raw && raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {},
    resetParams: normalizeParams(raw && raw.resetParams),
    aiControl: {
      clothing,
      accessories,
      motionPrefixes: Array.isArray(rawAi.motionPrefixes)
        ? rawAi.motionPrefixes.filter((prefix) => typeof prefix === "string")
        : []
    },
    scenes
  };
}

function normalizeScenesConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const defaults = config.defaults && typeof config.defaults === "object" ? config.defaults : {};
  const ai = Object.assign({}, DEFAULT_AI, config.ai && typeof config.ai === "object" ? config.ai : {});
  ai.enabled = ai.enabled !== false;
  ai.cooldownMs = Math.max(0, num(ai.cooldownMs, DEFAULT_AI.cooldownMs));
  ai.priorityCooldownMs = Math.max(0, num(ai.priorityCooldownMs, DEFAULT_AI.priorityCooldownMs));
  const models = {};
  if (config.models && typeof config.models === "object") {
    for (const [modelId, rawEntry] of Object.entries(config.models)) {
      models[modelId] = normalizeModelEntry(rawEntry, modelId);
    }
  }
  return {
    version: num(config.version, 1),
    description: typeof config.description === "string" ? config.description : "",
    defaults: {
      transitionMs: Math.max(0, num(defaults.transitionMs, 900)),
      cooldownMs: Math.max(0, num(defaults.cooldownMs, ai.cooldownMs)),
      priorityCooldownMs: Math.max(0, num(defaults.priorityCooldownMs, ai.priorityCooldownMs)),
      categoryOrder: Array.isArray(defaults.categoryOrder) && defaults.categoryOrder.length
        ? defaults.categoryOrder.filter((c) => typeof c === "string")
        : CATEGORY_ORDER.slice()
    },
    ai,
    models
  };
}

function loadScenesConfig(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { filePath, config: normalizeScenesConfig(raw), error: null };
  } catch (error) {
    return { filePath, config: normalizeScenesConfig({}), error: String((error && error.message) || error) };
  }
}

// 合并多份场景配置：手工 scenes.json 优先，scenes.generated.json 只补缺；
// displayOverrides 是 model-display.json（每模型缩放/隐藏部件）与旧 config.hiddenParts 的合并结果。
function mergeScenesConfigs(baseConfig, generatedConfig, displayOverrides, legacyHiddenParts, legacyHiddenDrawables) {
  const base = normalizeScenesConfig(baseConfig);
  const generated = normalizeScenesConfig(generatedConfig);
  const models = {};
  for (const [id, entry] of Object.entries(base.models)) models[id] = entry;
  for (const [id, entry] of Object.entries(generated.models)) {
    if (!models[id]) models[id] = entry;
  }
  const overrides = displayOverrides && typeof displayOverrides === "object" ? displayOverrides : {};
  const legacy = legacyHiddenParts && typeof legacyHiddenParts === "object" ? legacyHiddenParts : {};
  const legacyDrawables = legacyHiddenDrawables && typeof legacyHiddenDrawables === "object" ? legacyHiddenDrawables : {};
  for (const [id, entry] of Object.entries(models)) {
    const override = overrides[id] && typeof overrides[id] === "object" ? overrides[id] : null;
    const legacyParts = Array.isArray(legacy[id]) ? legacy[id] : [];
    const overrideParts = override && Array.isArray(override.hiddenParts) ? override.hiddenParts : [];
    // 手工配置了 scale 时优先；否则用 model-display.json 的探测/覆盖值
    if (entry.display.scale === null && override && override.scale !== undefined && override.scale !== null) {
      const scale = num(override.scale, null);
      if (scale !== null) entry.display.scale = scale;
    }
    // hiddenParts 合并去重（model-display.json 探测结果 + 旧 config.hiddenParts 手工值）
    const mergedParts = [];
    for (const part of [...overrideParts, ...legacyParts, ...entry.hiddenParts]) {
      const key = typeof part === "number" ? `i:${part}` : `s:${part}`;
      if (mergedParts.some((item) => (typeof item === "number" ? `i:${item}` : `s:${item}`) === key)) continue;
      mergedParts.push(part);
    }
    entry.hiddenParts = mergedParts;
    // hiddenDrawables：Cubism3/4 背景不是独立部件时的 drawable 索引（model-display.json 覆盖写）
    const overrideDrawables = override && Array.isArray(override.hiddenDrawables) ? override.hiddenDrawables : [];
    const legacyDrawables = Array.isArray(legacyHiddenDrawables[id]) ? legacyHiddenDrawables[id] : [];
    const mergedDrawables = [];
    for (const item of [...overrideDrawables, ...legacyDrawables, ...entry.hiddenDrawables]) {
      const n = Number(item);
      if (!Number.isFinite(n) || n < 0 || mergedDrawables.includes(n)) continue;
      mergedDrawables.push(n);
    }
    entry.hiddenDrawables = mergedDrawables;
  }
  return {
    ...base,
    description: base.description,
    models,
    generatedAt: generated.generatedAt || null,
    mergedAt: new Date().toISOString()
  };
}

function getModelScenes(config, modelId) {
  const cfg = normalizeScenesConfig(config);
  const entry = (modelId && cfg.models[modelId]) || cfg.models.__fallback__ || null;
  if (!entry) return { modelId, displayName: "", display: { scale: null }, hiddenParts: [], hiddenDrawables: [], capabilities: {}, resetParams: {}, aiControl: { clothing: null, accessories: [], motionPrefixes: [] }, scenes: [], fallback: false };
  return {
    modelId: modelId && cfg.models[modelId] ? modelId : "__fallback__",
    displayName: entry.displayName,
    display: entry.display,
    hiddenParts: entry.hiddenParts || [],
    hiddenDrawables: entry.hiddenDrawables || [],
    capabilities: entry.capabilities,
    resetParams: entry.resetParams,
    aiControl: entry.aiControl,
    scenes: entry.scenes,
    fallback: !(modelId && cfg.models[modelId])
  };
}

function findScene(scenes, sceneId) {
  const wanted = String(sceneId || "").trim().toLowerCase();
  if (!wanted || !Array.isArray(scenes)) return null;
  return scenes.find((scene) => scene.id.toLowerCase() === wanted) || null;
}

// 解析显式场景标签，如 "好呀[scene:shy]"；返回剥离标签后的文本与标签 id 列表
function parseSceneTags(text) {
  const source = String(text || "");
  const ids = [];
  SCENE_TAG_RE.lastIndex = 0;
  let match;
  while ((match = SCENE_TAG_RE.exec(source))) {
    const id = String(match[1] || "").toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { text: stripSceneTags(source), sceneIds: ids };
}

function stripSceneTags(text) {
  return String(text || "")
    .replace(SCENE_TAG_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。！？,!?])/g, "$1")
    .trim();
}

// 关键词匹配：命中最多/最长的关键词优先，其次场景 priority 高者优先
function matchSceneByText(scenes, text, options) {
  const source = String(text || "").toLowerCase();
  if (!source.trim() || !Array.isArray(scenes)) return null;
  const opts = options || {};
  const excludeId = opts.excludeId ? String(opts.excludeId).toLowerCase() : "";
  let best = null;
  for (const scene of scenes) {
    if (!scene || excludeId && scene.id.toLowerCase() === excludeId) continue;
    for (const keyword of scene.keywords || []) {
      if (!keyword || !source.includes(keyword)) continue;
      const score = keyword.length * 10 + (scene.priority || 1) * 3;
      if (!best || score > best.score) {
        best = { scene, keyword, score, matchedBy: "keyword" };
      }
    }
  }
  return best;
}

// AI 提示词：告诉模型有哪些场景标签可用，并约定输出格式
function buildScenePrompt(config, modelId) {
  const cfg = normalizeScenesConfig(config);
  const info = getModelScenes(cfg, modelId);
  const scenes = info.scenes;
  if (!cfg.ai.enabled || !scenes.length) return "";
  const list = scenes
    .map((scene) => `- ${scene.id}（${scene.category}）：${scene.label}${scene.keywords.length ? `；关键词：${scene.keywords.slice(0, 6).join("、")}` : ""}`)
    .join("\n");
  const toolLines = [];
  if (info.aiControl && info.aiControl.clothing) {
    const clothing = info.aiControl.clothing;
    toolLines.push(`- 服装：可用 set_clothing 工具设置 ${clothing.param}（${clothing.min}=穿好，${clothing.max}=全裸，中间值为半脱/过渡）。`);
  }
  if (info.aiControl && info.aiControl.accessories && info.aiControl.accessories.length) {
    for (const accessory of info.aiControl.accessories) {
      toolLines.push(`- 饰品「${accessory.label || accessory.id}」：可用 set_accessory 工具（accessory_id=${accessory.id}，on=true 戴上 / on=false 摘下）。`);
    }
  }
  return [
    "【动作/场景控制协议】",
    "你可以使用以下工具精确控制桌宠当前模型的场景/动作/服装。用户明确要求换动作、脱衣/穿衣、戴/摘眼镜时，优先调用工具，不要只在文字里描述。",
    "可用工具：play_scene、play_motion、list_motions、switch_model" + (toolLines.length ? "、set_clothing、set_accessory" : "") + "。",
    "场景标签（工具不可用时的文本回退）如下：",
    list,
    ...toolLines,
    `工具不可用（接口不支持 function calling）时，可在回复最后追加一个标签，格式 ${cfg.ai.tagPrefix}id${cfg.ai.tagSuffix}，例如 ${cfg.ai.tagPrefix}${scenes[0].id}${cfg.ai.tagSuffix}；标签不会显示给用户、也不会被朗读。`,
    "每次最多输出一个标签；不需要切换场景时不要输出标签；不要编造没有列出的场景/工具。回复保持短而自然，适合直接语音播放。"
  ].join("\n");
}

// 生成给 OpenAI 兼容接口的 system prompt（角色卡 + 动态场景协议）
function buildSystemPrompt(rolePrompt, config, modelId) {
  const scenePrompt = buildScenePrompt(config, modelId);
  return [String(rolePrompt || "").trim(), scenePrompt].filter(Boolean).join("\n\n");
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_PRIORITY,
  DEFAULT_AI,
  SCENE_TAG_RE,
  normalizeScenesConfig,
  normalizeScene,
  loadScenesConfig,
  mergeScenesConfigs,
  getModelScenes,
  findScene,
  parseSceneTags,
  stripSceneTags,
  matchSceneByText,
  buildScenePrompt,
  buildSystemPrompt
};
