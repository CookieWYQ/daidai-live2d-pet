// Live2D 模型注册表：手工导入模型 + 可选模型库扫描（根目录由外部传入，不写死路径）
// - 模型资源只读引用（绝对路径），不复制
// - 扫描时从 model_info.json 提取动作/原声关联/动作组，生成 scenes.generated.json
// - 手工 scenes.json 里的模型配置优先级更高（由主进程合并）
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readJson, writeJson } = require("./config-store");
const {
  GENERATED_SCENES_FILE,
  MODEL_DISPLAY_FILE,
  scanModelRoots,
  buildGeneratedScenes,
  writeGeneratedScenes,
  readModelDisplayOverrides
} = require("./model-library");

const MODEL_FILE_PATTERNS = [".model3.json", ".model.json"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeId(input) {
  const ascii = String(input || "model")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `model-${Date.now()}`;
}

function walkFiles(dir, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full, depth + 1, maxDepth));
    } else {
      files.push(full);
    }
  }
  return files;
}

function findLive2dModelFile(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Model directory does not exist: ${dir}`);
  }

  const rootFiles = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name));
  const allFiles = [...rootFiles, ...walkFiles(dir).filter((file) => !rootFiles.includes(file))];

  for (const suffix of MODEL_FILE_PATTERNS) {
    const match = allFiles.find((file) => file.toLowerCase().endsWith(suffix));
    if (match) return match;
  }
  throw new Error("No Live2D .model.json or .model3.json file found");
}

function modelKindFromFile(modelFile) {
  return modelFile.toLowerCase().endsWith(".model3.json") ? "cubism3+" : "cubism2";
}

function normalizeModelRecord(record) {
  const modelPath = path.resolve(record.modelPath);
  const directory = path.resolve(record.directory || path.dirname(modelPath));
  // 保留扫描得到的扩展字段（bundle/game/links/canvas/display...），只覆盖路径派生字段
  return {
    ...record,
    id: record.id,
    name: record.name || record.id,
    source: record.source || "user",
    kind: record.kind || modelKindFromFile(modelPath),
    directory,
    modelPath,
    modelUrl: pathToFileURL(modelPath).href,
    importedAt: record.importedAt || new Date().toISOString()
  };
}

// 保存到 models.json 前裁掉大字段（motionIndex 只用于扫描期生成场景；links 渲染进程播放原声要用）
function compactRecord(record) {
  const out = { ...record };
  delete out.motionIndex;
  delete out.modelInfoFile;
  delete out.displaySource;
  return out;
}

function normalizePathKey(file) {
  return path.resolve(String(file || "")).toLowerCase();
}

function copyDirectory(source, target) {
  ensureDir(path.dirname(target));
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

function createModelRegistry({ userDataDir, bundledModelsDir, libraryRoots, excludedRoots }) {
  const modelsDir = path.join(userDataDir, "models");
  const registryFile = path.join(userDataDir, "models.json");
  const generatedScenesFile = path.join(userDataDir, GENERATED_SCENES_FILE);
  const displayConfigFile = path.join(userDataDir, MODEL_DISPLAY_FILE);
  let lastLibraryScan = null;

  function loadRegistry() {
    return readJson(registryFile, { models: [] });
  }

  function saveRegistry(models) {
    writeJson(registryFile, { models: models.map((model) => compactRecord(normalizeModelRecord(model))) });
  }

  function listBundledModels() {
    if (!bundledModelsDir || !fs.existsSync(bundledModelsDir)) return [];
    return fs
      .readdirSync(bundledModelsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = path.join(bundledModelsDir, entry.name);
        try {
          const modelPath = findLive2dModelFile(directory);
          return normalizeModelRecord({
            id: `bundled-${safeId(entry.name)}`,
            name: entry.name,
            source: "bundled",
            directory,
            modelPath
          });
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function sortModels(models) {
    return models.slice().sort((a, b) => {
      const sourceRank = (model) => (model.source === "user" ? 0 : model.source === "library" ? 1 : 2);
      const rank = sourceRank(a) - sourceRank(b);
      if (rank) return rank;
      const bundle = String(a.bundleLabel || "").localeCompare(String(b.bundleLabel || ""));
      if (bundle) return bundle;
      const game = String(a.game || "").localeCompare(String(b.game || ""));
      if (game) return game;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  // 扫描模型库并把结果合并进 models.json（保留已有 id/手工模型/默认选中）
  function rescanLibrary(options) {
    const opts = options || {};
    // 允许主进程在重新扫描时传入最新根目录（配置文件改了模型库路径后无需重启）
    const roots = (opts.roots && opts.roots.length ? opts.roots : libraryRoots) || [];
    const excluded = opts.excluded || excludedRoots || [];
    const displayOverrides = readModelDisplayOverrides(userDataDir);
    const scan = scanModelRoots({ roots, displayOverrides });
    const crawled = scan.models;
    const scannedByPath = new Map(crawled.map((model) => [normalizePathKey(model.modelPath), model]));
    const registry = loadRegistry();
    const next = [];
    const usedPaths = new Set();

    for (const raw of registry.models) {
      let record;
      try {
        record = normalizeModelRecord(raw);
      } catch {
        continue;
      }
      const key = normalizePathKey(record.modelPath);
      const scanned = scannedByPath.get(key);
      if (scanned) {
        // 已有记录（手工导入/上次扫描）：保留 id/name/source，补全扫描元数据
        next.push(normalizeModelRecord({
          ...scanned,
          id: record.id,
          name: record.name || scanned.name,
          source: record.source || scanned.source,
          importedAt: record.importedAt || scanned.importedAt
        }));
        usedPaths.add(key);
      } else if (record.source === "library") {
        // 模型库里的路径已不存在：移除，避免点开就报错
        continue;
      } else if (fs.existsSync(record.modelPath)) {
        next.push(record);
        usedPaths.add(key);
      }
    }
    for (const scanned of crawled) {
      const key = normalizePathKey(scanned.modelPath);
      if (usedPaths.has(key)) continue;
      next.push(normalizeModelRecord(scanned));
      usedPaths.add(key);
    }
    saveRegistry(next);

    // 生成场景：以最终注册表 id 为 key（手工 scenes.json 覆盖由主进程合并）
    const finalModels = next.map((model) => normalizeModelRecord(model));
    const generated = buildGeneratedScenes(
      { models: finalModels.map((model) => ({ ...model, motionIndex: model.motionIndex || [] })), generatedAt: scan.generatedAt },
      displayOverrides
    );
    writeGeneratedScenes(userDataDir, generated);

    const stats = {
      total: finalModels.length,
      cubism2: finalModels.filter((model) => model.kind === "cubism2").length,
      cubism3: finalModels.filter((model) => model.kind !== "cubism2").length,
      library: finalModels.filter((model) => model.source === "library").length,
      generatedScenes: finalModels.length,
      generatedAt: generated.generatedAt
    };
    lastLibraryScan = {
      stats,
      roots: roots.map((root) => ({ key: root.key, label: root.label, dir: root.dir })),
      excluded,
      issues: scan.issues,
      generatedScenesFile,
      displayConfigFile,
      displayOverridesFound: Object.keys(displayOverrides.models || {}).length,
      scannedAt: new Date().toISOString(),
      elapsedMs: 0
    };
    return lastLibraryScan;
  }

  return {
    modelsDir,
    registryFile,
    generatedScenesFile,
    displayConfigFile,
    libraryInfo() {
      return lastLibraryScan;
    },
    list() {
      const userModels = loadRegistry().models.map(normalizeModelRecord);
      const bundled = listBundledModels();
      // 去重：按模型文件路径；用户/扫描记录优先于 bundled
      const byPath = new Map();
      for (const model of [...bundled, ...userModels]) {
        const key = normalizePathKey(model.modelPath);
        if (!byPath.has(key)) byPath.set(key, model);
        else if (model.source !== "bundled") byPath.set(key, model);
      }
      return sortModels([...byPath.values()]);
    },
    get(id) {
      return this.list().find((model) => model.id === id) || null;
    },
    rescanLibrary,
    importDirectory(sourceDir) {
      const sourceModelFile = findLive2dModelFile(sourceDir);
      const baseId = safeId(path.basename(sourceDir));
      let id = baseId;
      const existingIds = new Set(this.list().map((model) => model.id));
      let index = 2;
      while (existingIds.has(id)) {
        id = `${baseId}-${index}`;
        index += 1;
      }

      const targetDir = path.join(modelsDir, id);
      copyDirectory(sourceDir, targetDir);
      const relativeModel = path.relative(sourceDir, sourceModelFile);
      const modelPath = path.join(targetDir, relativeModel);
      const record = normalizeModelRecord({
        id,
        name: path.basename(sourceDir),
        source: "user",
        directory: targetDir,
        modelPath
      });

      const registry = loadRegistry();
      saveRegistry([...registry.models.filter((model) => model.id !== id), record]);
      return record;
    },
    openDirectoryPath() {
      ensureDir(modelsDir);
      return modelsDir;
    }
  };
}

module.exports = {
  createModelRegistry,
  findLive2dModelFile,
  modelKindFromFile,
  normalizeModelRecord,
  safeId
};
