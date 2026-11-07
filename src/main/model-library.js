// 模型库扫描：只读引用本地 Live2D 模型库目录，不复制模型资源。
// 目录约定：<模型库根>/1_FFhouse/<游戏>/<模型目录>/…；<模型库根>/2_Tyrano/<游戏>/<模型目录>/…
// 模型库根目录不写死在代码里（方便开源分发 / 换机器）：
//   - 优先读 DAIDAI_MODEL_LIBRARY 环境变量；
//   - 否则读 user-data/config.json 的 modelLibraryRoots 数组（取第一项）。
// 仓库本身不附带任何模型；未配置时扫描结果为空，仍可在管理页手工导入模型目录。
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const GENERATED_SCENES_FILE = "scenes.generated.json";
const MODEL_DISPLAY_FILE = "model-display.json";

const MODEL_LIBRARY_SUBDIRS = [
  { key: "ffhouse", label: "文件夹1 · FFhouse", subdir: "1_FFhouse", description: "Unity 提取的 Cubism3 模型" },
  { key: "tyrano", label: "文件夹2 · Tyrano", subdir: "2_Tyrano", description: "Tyrano 游戏提取模型（Cubism2 / Cubism3）" }
];

const EXCLUDED_SUBDIRS = [
  {
    key: "necwai",
    label: "文件夹3 · NecwaiWorks",
    subdir: "3_NecwaiWorks",
    reason: "不含 Live2D 模型（Unity 2D Animation 图集 / 精灵动画），无法用 Cubism2/3 运行时渲染，因此不支持"
  }
];

function buildModelRoots(baseDir) {
  const base = String(baseDir || "").trim();
  if (!base) return [];
  return MODEL_LIBRARY_SUBDIRS.map((item) => ({
    key: item.key,
    label: item.label,
    dir: path.join(base, item.subdir),
    description: item.description
  }));
}

function buildExcludedRoots(baseDir) {
  const base = String(baseDir || "").trim();
  if (!base) return [];
  return EXCLUDED_SUBDIRS.map((item) => ({
    key: item.key,
    label: item.label,
    dir: path.join(base, item.subdir),
    reason: item.reason
  }));
}

const DEF_SUFFIXES = [".model3.json", ".model.json"];

function safeKey(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// FNV-1a 32bit：给中文路径生成稳定短 id（不依赖平台/顺序）
function hashId(input) {
  let h = 0x811c9dc5;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(0, 8);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function walkFiles(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, depth + 1, maxDepth, out);
    else out.push(full);
  }
  return out;
}

function isModelDefFile(file) {
  const base = path.basename(file).toLowerCase();
  if (base === "model_info.json") return false;
  return DEF_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function kindFromFile(file) {
  return String(file).toLowerCase().endsWith(".model3.json") ? "cubism3+" : "cubism2";
}

function normalizeRel(file) {
  return String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

// 把动作文件路径规范成不带目录 / 扩展名的动作名（与渲染进程 sceneMotionMap 保持一致）
function motionNameOf(file) {
  const raw = normalizeRel(file);
  const base = raw.replace(/^.*\//, "");
  return base.replace(/\.(motion3\.json|model3\.json|model\.json|mtn|json)$/i, "");
}

function motionGroupOf(file, fallback) {
  const raw = normalizeRel(file);
  const match = raw.match(/motions\/([^/]+)\//i);
  if (match) return match[1];
  return fallback === undefined || fallback === null ? "" : String(fallback);
}

function resolveSoundFile(sound, searchDirs) {
  const raw = String(sound || "").replace(/\\/g, "/");
  if (!raw) return null;
  if (/^[a-z]+:/i.test(raw) && fs.existsSync(raw)) return raw;
  const cleaned = raw.replace(/^\.\//, "");
  const candidates = [];
  for (const dir of searchDirs) {
    if (!dir) continue;
    candidates.push(path.resolve(dir, cleaned));
    // folder1 的 model_info 用 ../audio/xxx，links.json 里也有 audio/xxx 的写法
    if (cleaned.startsWith("../")) candidates.push(path.resolve(dir, cleaned.replace(/^(\.\.\/)+/, "")));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function collectModelDirs(rootKey, rootDir, out) {
  const files = walkFiles(rootDir, 0, 5, []);
  const infoFiles = files.filter((file) => path.basename(file).toLowerCase() === "model_info.json");
  const defFiles = files.filter(isModelDefFile);
  const dirs = new Map();

  for (const infoFile of infoFiles) {
    const dir = path.dirname(infoFile);
    dirs.set(dir.toLowerCase(), { dir, infoFile, defFiles: [] });
  }
  for (const defFile of defFiles) {
    const dir = path.dirname(defFile);
    const key = dir.toLowerCase();
    if (!dirs.has(key)) dirs.set(key, { dir, infoFile: null, defFiles: [] });
    dirs.get(key).defFiles.push(defFile);
  }
  return [...dirs.values()].map((entry) => ({ ...entry, rootKey, rootDir }));
}

function pickModelFile(dirEntry, info) {
  const defs = dirEntry.defFiles.slice();
  if (info && info.model_file) {
    const candidate = path.join(dirEntry.dir, String(info.model_file));
    if (fs.existsSync(candidate)) return candidate;
  }
  // 优先和目录同名的定义文件，其次 model3 优先
  const baseName = path.basename(dirEntry.dir).toLowerCase();
  const byDirName = defs.find((file) => path.basename(file).toLowerCase().replace(/\.model3?\.json$/, "") === baseName);
  if (byDirName) return byDirName;
  const c3 = defs.find((file) => /\.model3\.json$/i.test(file));
  return c3 || defs[0] || null;
}

function extractMotionsFromDef(modelFile, info, dir) {
  const def = readJsonSafe(modelFile, null);
  const motions = [];
  if (def) {
    const refs = def.FileReferences || {};
    const rawMotions = refs.Motions || def.motions || {};
    for (const [group, list] of Object.entries(rawMotions)) {
      if (!Array.isArray(list)) continue;
      list.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const file = item.File || item.file || "";
        if (!file) return;
        motions.push({
          group: String(group),
          index,
          name: motionNameOf(file),
          file: normalizeRel(file),
          sound: item.Sound || item.sound || null
        });
      });
    }
  }
  // model_info.motions 是前期提取流程的权威索引（带 group/name/sound），优先用它补齐
  if (info && Array.isArray(info.motions) && info.motions.length) {
    const byKey = new Map();
    for (const motion of motions) byKey.set(`${motion.group}|${motion.name}`, motion);
    for (const item of info.motions) {
      if (!item || !item.file) continue;
      const name = String(item.name || motionNameOf(item.file));
      const group = item.group === undefined || item.group === null ? motionGroupOf(item.file) : String(item.group);
      const key = `${group}|${name}`;
      const existing = byKey.get(key);
      if (existing) {
        if (item.sound) existing.sound = item.sound;
        if (item.duration_sec !== undefined) existing.durationSec = item.duration_sec;
        if (item.loop !== undefined) existing.loop = item.loop;
      } else {
        byKey.set(key, {
          group,
          index: motions.length,
          name,
          file: normalizeRel(item.file),
          sound: item.sound || null,
          durationSec: item.duration_sec,
          loop: item.loop
        });
        motions.push(byKey.get(key));
      }
    }
  }
  return motions;
}

function collectLinks(modelDir, gameDir, rootDir, info, motions) {
  const links = [];
  const push = (link) => {
    if (!link || !link.motion) return;
    const sound = link.sound || link.audio || "";
    if (!sound) return;
    const soundFile = resolveSoundFile(sound, [modelDir, gameDir, rootDir]);
    links.push({
      motion: normalizeRel(link.motion),
      motionName: motionNameOf(link.motion),
      action: link.action || motionNameOf(link.motion),
      sound: normalizeRel(sound),
      soundFile: soundFile || null,
      soundUrl: soundFile ? pathToFileURL(soundFile).href : null,
      evidence: link.evidence || "",
      confidence: link.confidence || ""
    });
  };

  const linksFile = path.join(modelDir, "links.json");
  const linksJson = fs.existsSync(linksFile) ? readJsonSafe(linksFile, null) : null;
  if (linksJson && Array.isArray(linksJson.links)) linksJson.links.forEach(push);
  if (info && Array.isArray(info.links)) info.links.forEach(push);

  // 兜底：model_info.motions 里带 sound 的动作也纳入（links.json 可能不全）
  if (info && Array.isArray(info.motions)) {
    info.motions.forEach((motion) => {
      if (!motion || !motion.file || !motion.sound) return;
      push({ action: motion.name, motion: motion.file, sound: motion.sound, evidence: motion.sound_evidence || "" });
    });
  }
  // 同一个 motion 保留第一条（links.json 的证据优先）
  const seen = new Set();
  const unique = [];
  for (const link of links) {
    const key = link.motion.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(link);
  }
  return unique;
}

function detectPrefixes(motions) {
  const counts = new Map();
  for (const motion of motions) {
    const name = String(motion.name || "");
    const match = name.match(/^([A-Za-z]{2,6}[_])/);
    const prefix = match ? match[1] : "";
    if (!prefix || prefix.length < 3) continue;
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([prefix]) => prefix);
}

function sceneSlug(input, fallback) {
  const key = safeKey(input);
  return key || `s-${hashId(input || fallback || "scene")}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickRepresentativeMotions(list, count) {
  const names = [];
  for (const motion of list) {
    if (!motion || !motion.name) continue;
    if (names.includes(motion.name)) continue;
    names.push(motion.name);
    if (names.length >= count) break;
  }
  return names;
}

// 通用场景生成：任何模型都至少得到 待机 / 随机动作 / 随机原声 / 动作组代表 / 动作系列
function buildScenesForModel(model) {
  const motions = Array.isArray(model.motionIndex) ? model.motionIndex : [];
  const links = Array.isArray(model.links) ? model.links : [];
  const linkNames = new Set(links.map((link) => link.motionName).filter(Boolean));
  const scenes = [];
  const usedIds = new Set();
  const add = (scene) => {
    if (!scene || !scene.id || usedIds.has(scene.id) || !scene.motions && !scene.randomMotion) return;
    usedIds.add(scene.id);
    scenes.push({
      category: "日常",
      priority: 1,
      keywords: [],
      motions: [],
      sound: "auto",
      transitionMs: 900,
      hint: "",
      ...scene
    });
  };

  const groups = new Map();
  for (const motion of motions) {
    const group = String(motion.group === undefined || motion.group === null ? "" : motion.group);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(motion);
  }
  const groupNames = [...groups.keys()];

  // 1) 待机：优先 idle/stand/breath 类动作组
  const idleGroupName = groupNames.find((group) => /^(idle|stand|base|breath|待机|loop)/i.test(group))
    || groupNames.find((group) => /idle|breath|stand/i.test(group))
    || groupNames[0]
    || "";
  const allMotionNames = motions.map((motion) => motion.name).filter(Boolean);
  const idleMotions = pickRepresentativeMotions(groups.get(idleGroupName) || motions, 2);
  add({
    id: "idle",
    label: "待机",
    keywords: ["待机", "休息", "安静", "idle", "stand", "待機"],
    motions: idleMotions.length ? idleMotions : allMotionNames.slice(0, 1),
    durationMs: 0,
    hint: "模型待机/呼吸动作（自动生成）"
  });

  // 2) 随机动作：优先“安全”的对话/过渡类，否则全量
  const safeNames = allMotionNames.filter((name) => /^(OP_|SJ_|tFRM_|uFRG_|vtaneG_|zED_|talk|hello|greet)/i.test(name));
  add({
    id: "random_action",
    label: "随机动作",
    keywords: ["随机动作", "动一下", "换个动作", "动作", "random"],
    randomMotion: true,
    motionFilter: safeNames.length >= 3 ? "^(OP_|SJ_|tFRM_|uFRG_|vtaneG_|zED_|talk|hello|greet)" : "",
    durationMs: 0,
    hint: "从模型动作里随机播放一个（自动生成）"
  });

  // 3) 随机原声动作：只在模型有“动作↔原声”关联时生成
  if (links.length) {
    add({
      id: "random_voice",
      label: "随机原声动作",
      keywords: ["说句话", "随机语音", "原声", "voice", "台词"],
      randomMotion: true,
      linkedOnly: true,
      durationMs: 0,
      hint: "随机播放一个带原声的动作（自动生成）"
    });
  }

  // 4) 动作组代表动作：组少时全列出；组多时抽样（避免 M02 的 169 个组爆面板）
  const groupOrder = groupNames.slice().sort((a, b) => {
    const score = (group) => (/idle|breath|talk|op|start/i.test(group) ? 0 : 1);
    return score(a) - score(b) || a.localeCompare(b);
  });
  const MAX_GROUP_SCENES = 20;
  let groupList = groupOrder;
  if (groupOrder.length > MAX_GROUP_SCENES) {
    const picked = [];
    const step = groupOrder.length / MAX_GROUP_SCENES;
    for (let i = 0; i < MAX_GROUP_SCENES; i += 1) picked.push(groupOrder[Math.floor(i * step)]);
    groupList = picked;
  }
  for (const group of groupList) {
    const list = groups.get(group) || [];
    const names = pickRepresentativeMotions(list, 3);
    if (!names.length) continue;
    const labelGroup = group || "全部动作";
    add({
      id: `group_${sceneSlug(group || "all")}`,
      label: `动作组 · ${labelGroup}`,
      keywords: group ? [group.toLowerCase()] : [],
      motions: names,
      durationMs: 0,
      hint: `动作组 ${labelGroup} 的代表动作（自动生成，组内 ${list.length} 个动作）`
    });
  }

  // 5) 动作系列（按 OP_ / tFRM_ 之类前缀随机）
  const prefixes = detectPrefixes(motions);
  for (const prefix of prefixes) {
    const count = motions.filter((motion) => String(motion.name).startsWith(prefix)).length;
    if (count < 3) continue;
    add({
      id: `series_${sceneSlug(prefix)}`,
      label: `动作系列 · ${prefix}（${count}）`,
      keywords: [prefix.replace(/_$/, "").toLowerCase()],
      randomMotion: true,
      motionFilter: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      durationMs: 0,
      hint: `随机播放 ${prefix} 系列动作（自动生成）`
    });
  }

  // 6) 有声动作系列：把带原声的动作单独做一个“随机”池（便于 AI 播完动作出声音）
  if (linkNames.size >= 3) {
    add({
      id: "series_voice",
      label: `原声动作（${linkNames.size}）`,
      keywords: ["语音", "voice", "说话"],
      randomMotion: true,
      linkedOnly: true,
      durationMs: 0,
      hint: "随机播放带原声的动作（自动生成）"
    });
  }

  return scenes;
}

function scanModelRoots(options) {
  const opts = options || {};
  const roots = opts.roots || [];
  const models = [];
  const issues = [];
  const displayOverrides = opts.displayOverrides && opts.displayOverrides.models ? opts.displayOverrides.models : {};
  const generatedAt = new Date().toISOString();

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) {
      issues.push({ root: root.key, dir: root.dir, issue: "模型根目录不存在" });
      continue;
    }
    const dirEntries = collectModelDirs(root.key, root.dir, []);
    for (const entry of dirEntries) {
      const info = entry.infoFile ? readJsonSafe(entry.infoFile, null) : null;
      const modelFile = pickModelFile(entry, info);
      if (!modelFile) {
        issues.push({ root: root.key, dir: entry.dir, issue: "未找到 .model.json / .model3.json" });
        continue;
      }
      const rel = path.relative(root.dir, entry.dir).split(path.sep).filter(Boolean);
      const game = rel.length > 1 ? rel[0] : "";
      const modelDirName = path.basename(entry.dir);
      const kind = kindFromFile(modelFile);
      const motions = extractMotionsFromDef(modelFile, info, entry.dir);
      const gameDir = game ? path.join(root.dir, game) : root.dir;
      const links = collectLinks(entry.dir, gameDir, root.dir, info, motions);
      const canvas = (info && info.verified && (info.verified.canvas_size || info.verified.canvas)) || null;
      const displayName = String((info && (info.display_name || info.name)) || modelDirName);
      const id = `lib-${root.key}-${hashId(path.relative(root.dir, entry.dir).replace(/\\/g, "/"))}`;
      const override = displayOverrides[id] || displayOverrides[path.resolve(entry.dir)] || {};
      models.push({
        id,
        name: displayName || modelDirName,
        displayName: displayName || modelDirName,
        source: "library",
        kind,
        directory: entry.dir,
        modelPath: modelFile,
        modelUrl: pathToFileURL(modelFile).href,
        importedAt: generatedAt,
        scannedAt: generatedAt,
        bundle: root.key,
        bundleLabel: root.label,
        game,
        modelDirName,
        modelType: (info && info.type) || kind,
        canvas,
        motionIndex: motions,
        motionCount: motions.length,
        motionGroups: [...new Set(motions.map((motion) => motion.group))],
        motionGroupCount: new Set(motions.map((motion) => motion.group)).size,
        links,
        linkCount: links.length,
        hasAudio: links.length > 0,
        modelInfoFile: entry.infoFile || null,
        display: {
          scale: numberOrNull(override && override.scale)
        },
        hiddenParts: Array.isArray(override && override.hiddenParts) ? override.hiddenParts.slice() : [],
        displaySource: override && (override.hiddenParts || override.scale) ? "model-display.json" : "auto"
      });
    }
  }
  return { models, issues, roots, generatedAt };
}

function buildGeneratedScenes(scan, displayOverrides) {
  const opts = displayOverrides || {};
  const overrides = opts.models || {};
  const models = {};
  for (const model of scan.models) {
    const override = overrides[model.id] || {};
    models[model.id] = {
      displayName: model.name,
      display: {
        scale: numberOrNull(override.scale) !== null
          ? numberOrNull(override.scale)
          : numberOrNull(model.display && model.display.scale)
      },
      hiddenParts: Array.isArray(override.hiddenParts) ? override.hiddenParts.slice() : (model.hiddenParts || []),
      hiddenDrawables: Array.isArray(override.hiddenDrawables) ? override.hiddenDrawables.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item >= 0) : [],
      capabilities: {
        generated: {
          supported: true,
          note: "由模型库扫描自动生成：待机/随机动作/随机原声/动作组代表/动作系列；无换装参数证据"
        },
        undress: { supported: false, note: "自动扫描模型：未发现服装参数证据" },
        accessory: { supported: false, note: "自动扫描模型：未发现饰品参数证据" }
      },
      aiControl: {
        clothing: null,
        accessories: [],
        motionPrefixes: detectPrefixes(model.motionIndex || [])
      },
      scenes: buildScenesForModel(model)
    };
  }
  return {
    version: 1,
    description: "自动生成场景（模型库扫描产物，勿手改；手工场景写在 app/config/scenes.json，优先级更高）",
    generatedAt: scan.generatedAt,
    modelCount: scan.models.length,
    models
  };
}

function scanModelLibrary(options) {
  const opts = options || {};
  const scan = scanModelRoots(opts);
  const display = opts.displayOverrides || { models: {} };
  const generated = buildGeneratedScenes(scan, display);
  return { scan, generated, excluded: opts.excluded || [] };
}

function writeGeneratedScenes(userDataDir, generated) {
  const file = path.join(userDataDir, GENERATED_SCENES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(generated, null, 1), "utf8");
  return file;
}

function readModelDisplayOverrides(userDataDir) {
  const file = path.join(userDataDir, MODEL_DISPLAY_FILE);
  const data = readJsonSafe(file, null);
  return {
    file,
    exists: Boolean(data),
    models: (data && data.models && typeof data.models === "object") ? data.models : {}
  };
}

module.exports = {
  GENERATED_SCENES_FILE,
  MODEL_DISPLAY_FILE,
  buildModelRoots,
  buildExcludedRoots,
  scanModelLibrary,
  scanModelRoots,
  buildGeneratedScenes,
  writeGeneratedScenes,
  readModelDisplayOverrides,
  motionNameOf,
  resolveSoundFile,
  hashId
};
