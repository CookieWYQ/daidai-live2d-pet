const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, shell, screen, Tray } = require("electron");
const { createCodexSessionMonitor } = require("./codex-session-monitor");
const {
  MIN_PET_WINDOW,
  PET_SCALE_MIN,
  PET_SCALE_MAX,
  HOTKEY_ACTIONS,
  CHAT_TEXT_MODES,
  createConfigStore
} = require("./config-store");
const { createChatHistoryStore } = require("./chat-history");
const { createModelRegistry } = require("./model-registry");
const { createStatusBridge } = require("./status-bridge");
const { createStatusPoller } = require("./status-poller");
const { resolveNsfwOverride, sfwState } = require("./sfw-mode");
const {
  loadScenesConfig,
  mergeScenesConfigs,
  getModelScenes,
  buildSystemPrompt,
  parseSceneTags,
  stripSceneTags
} = require("./scene-config");
const {
  loadSceneCatalog,
  entryForModel,
  auditCatalog,
  resolveStartupModel,
  buildCatalogPrompt
} = require("./scene-catalog");
const {
  loadCharacters,
  characterForModel,
  resolveCharacterPrompt,
  buildCharactersPayload,
  saveCharacterPrompt
} = require("./character-registry");
const { buildModelRoots, buildExcludedRoots, readModelDisplayOverrides } = require("./model-library");

// 单实例锁：必须在注册全局快捷键之前拿到。否则开机自启 + 用户再点一次图标时，
// 第二个实例注册快捷键会全部静默失败，表现成「快捷键突然全失效」。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 用户重复启动：把已有桌宠叫到前面，而不是开第二个进程
    try {
      if (!petWindow || petWindow.isDestroyed()) createPetWindow();
      if (petWindow && !petWindow.isDestroyed()) {
        if (!petWindow.isVisible()) petWindow.show();
        petWindow.focus();
      }
    } catch (e) {}
  });
}

// SFW/NSFW：默认 SFW 毛玻璃；--nsfw / DAIDAI_NSFW=1 可在测试/截图时强制清晰（仅本次运行）
let nsfwOverride = resolveNsfwOverride({ argv: process.argv.slice(1), env: process.env });
// 自动化测试/会话内临时覆盖（debug 钩子，不写入 config.json；null 表示不覆盖）
let debugMainNsfwOverride = null;
function effectiveNsfwOverride() {
  return debugMainNsfwOverride !== null ? debugMainNsfwOverride : nsfwOverride;
}
// 调试钩子（CDP 自检/托盘菜单截图）仅在显式开启时暴露
const DEBUG_HOOKS = process.env.DAIDAI_DEBUG_HOOKS === "1" || process.argv.includes("--debug-hooks");

let petWindow = null;
let managerWindow = null;
let scenesWindow = null;
let tray = null;
let trayMenu = null;
let configStore = null;
// 聊天历史（user-data/chat-history.json）：文本模式的持久化记录
let chatHistory = null;
// 全局快捷键注册结果（{ id, name, accelerator, registered, error, effective, rollback? }[]）
let hotkeyStatus = [];
let hotkeyStatusAt = 0;
// 当前真正生效的绑定（id -> accelerator）。改键失败时用它回滚旧键。
let activeHotkeys = new Map();
let modelRegistry = null;
let statusBridge = null;
let codexMonitor = null;
let statusPoller = null;
let config = null;
let userHidden = false;
let cursorTimer = null;
let boundsSaveTimer = null;
let dragEndTimer = null;
let topTimer = null;
let lastMoveBounds = null;
let lastMoveAt = 0;
// 场景系统：scenes.json 配置 + 最近一次场景执行状态（由宠物窗渲染进程上报）
let scenesConfig = null;
let scenesFilePath = "";
let scenesGeneratedFilePath = "";
let modelDisplayFilePath = "";
// 场景目录（63 个模型 = 可切换场景，带给 AI 的描述/调用时机）
let sceneCatalog = null;
let sceneCatalogInfo = null;
let sceneCatalogPath = "";
// 角色注册表（角色 → 模型 → 场景 → 动作）：每个角色一张角色卡提示词
let characterRegistry = null;
let characterRegistryInfo = null;
let lastScaleInfo = null;
// 缩放窗口期间避免 resize 事件把 petWindowBase 写坏
let applyingPetScale = false;
let lastSceneState = null;
// AI 控制：渲染进程上报的当前模型能力清单（含 function calling 工具 schema）
let lastCapabilities = null;
let toolCallSeq = 0;
const pendingToolCalls = new Map();
// 若聊天接口明确不支持 tools（400/404/422），记住并自动回退文本标签协议，避免每次都报错
let toolsUnsupported = false;

// 模型库根目录：DAIDAI_MODEL_LIBRARY 环境变量优先，其次 user-data/config.json 的 modelLibraryRoots。
// 仓库不附带模型；未配置时 roots=[]，扫描结果为空，仍可在管理页手工导入单个模型。
function modelLibrarySettings() {
  const envBase = String(process.env.DAIDAI_MODEL_LIBRARY || "").trim();
  const configured = config && Array.isArray(config.modelLibraryRoots) ? config.modelLibraryRoots : [];
  const base = envBase || String(configured[0] || "").trim();
  return {
    base,
    roots: buildModelRoots(base),
    excluded: buildExcludedRoots(base)
  };
}

// 把 AI 的工具调用转发到宠物窗渲染进程执行，并等待结果（超时 5s 返回失败）
function petRunTool(name, args) {
  if (!petWindow || petWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, reason: "pet_window_missing" });
  }
  const requestId = "tool_" + (++toolCallSeq) + "_" + Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(requestId);
      resolve({ ok: false, reason: "timeout" });
    }, name === "switch_model" ? 20000 : 5000);
    pendingToolCalls.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    petWindow.webContents.send("pet:tool-call", { requestId, name, args: args || {} });
  });
}

function rendererFile() {
  return path.join(__dirname, "..", "renderer", "index.html");
}

function appIcon() {
  return path.join(__dirname, "..", "renderer", "assets", "app-icon.png");
}

function selectedModel() {
  return config.selectedModelId ? modelRegistry.get(config.selectedModelId) : null;
}

// 上一个模型（用于 AI“换回上一个”）：只在进程内记忆，任何入口切模型都会更新
let previousModelId = "";
function rememberModelSwitch(nextModelId) {
  const currentId = config && config.selectedModelId ? config.selectedModelId : "";
  if (currentId && nextModelId && currentId !== nextModelId) {
    previousModelId = currentId;
  }
}

function scanSoundsDir() {
  const dir = path.join(app.getPath("userData"), "sounds");
  if (!fs.existsSync(dir)) return [];
  const sounds = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(mp3|wav|ogg)$/i.test(entry.name)) {
        const full = path.join(dir, entry.name);
        sounds.push({ id: entry.name, name: entry.name, url: pathToFileURL(full).href });
      }
    }
  } catch {}
  return sounds.sort((a, b) => a.name.localeCompare(b.name));
}

function rendererPayload() {
  return {
    appVersion: app.getVersion(),
    config,
    models: modelRegistry.list(),
    selectedModel: selectedModel(),
    previousModel: previousModelId ? modelRegistry.get(previousModelId) : null,
    selectedSounds: scanSoundsDir(),    // SFW 毛玻璃：渲染进程据此显示/移除遮罩（forced 非 null 时为启动参数强制，测试用）
    sfw: sfwState(config, effectiveNsfwOverride()),
    // 场景系统：scenes.json 全量配置 + 最近场景状态 + AI 自动切换开关
    sceneConfig: scenesConfig,
    scenesPath: scenesFilePath,
    scenesGeneratedPath: scenesGeneratedFilePath,
    modelDisplayPath: modelDisplayFilePath,
    // 场景目录（63 个模型的语义/描述/whenToUse/NSFW 限制/证据）
    sceneCatalog: sceneCatalog,
    sceneCatalogPath: sceneCatalogPath,
    sceneCatalogInfo: sceneCatalogInfo,
    // 角色注册表：角色卡提示词 + 模型→角色映射 + 当前模型对应角色
    characters: buildCharactersPayload(characterRegistry, selectedModel()),
    characterInfo: characterRegistryInfo,
    // 桌宠缩放状态
    petScale: petScaleInfo(),
    petScaleRange: { min: PET_SCALE_MIN, max: PET_SCALE_MAX, step: 0.01 },
    // 全局快捷键：配置 + 实际注册结果（管理页据此显示冲突/禁用原因）
    hotkeys: config.hotkeys,
    hotkeyStatus,
    hotkeyStatusAt,
    hotkeyActions: HOTKEY_ACTIONS,
    // 聊天文本输出 / 历史记录
    chat: config.chat,
    chatTextModes: CHAT_TEXT_MODES,
    ttsConfigured: Boolean(config.tavern && config.tavern.ttsToken),
    chatHistoryInfo: chatHistory ? chatHistory.stats() : null,
    // 模型库扫描信息（63 个模型 / 排除的文件夹3 / 扫描问题）
    libraryInfo: modelRegistry ? modelRegistry.libraryInfo() : null,
    sceneState: lastSceneState,
    sceneAutoEnabled: config.sceneAutoEnabled !== false,
    // AI 控制：当前模型能力清单（动作/场景/换装/饰品 + tools schema）
    capabilities: lastCapabilities,
    status: statusPoller ? statusPoller.getLastStatus() : { sources: [] }
  };
}

function broadcast() {
  const payload = rendererPayload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("app:update", payload);
  }
}

function keepPetOnTop() {
  if (!petWindow || petWindow.isDestroyed() || !config || !config.alwaysOnTop) return;
  petWindow.setAlwaysOnTop(true, "screen-saver");
}

function startAlwaysOnTopGuard() {
  if (topTimer) return;
  topTimer = setInterval(keepPetOnTop, 1000);
}

function savePetBounds() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  const scale = Number(config.petScale || 1) || 1;
  const patch = {
    petWindow: {
      ...config.petWindow,
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    }
  };
  // 用户手动拖拽窗口边缘时，把当前尺寸记为新的 100% 基准（缩放窗口本身时跳过）
  if (!applyingPetScale) {
    patch.petWindowBase = {
      width: Math.max(MIN_PET_WINDOW.width, Math.round(bounds.width / scale)),
      height: Math.max(MIN_PET_WINDOW.height, Math.round(bounds.height / scale))
    };
  }
  config = configStore.save(patch);
  broadcast();
}

function resolvePetWindowBounds(savedBounds) {  let width = Math.max(MIN_PET_WINDOW.width, Number(savedBounds.width || 520));
  let height = Math.max(MIN_PET_WINDOW.height, Number(savedBounds.height || 620));
  const point = {
    x: Number.isFinite(savedBounds.x) ? savedBounds.x : 0,
    y: Number.isFinite(savedBounds.y) ? savedBounds.y : 0
  };
  const display = screen.getDisplayMatching({ ...point, width, height });
  const area = display.workArea;
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);

  const result = { width, height };
  if (Number.isFinite(savedBounds.x)) {
    result.x = Math.round(Math.min(Math.max(savedBounds.x, area.x), area.x + area.width - width));
  }
  if (Number.isFinite(savedBounds.y)) {
    result.y = Math.round(Math.min(Math.max(savedBounds.y, area.y), area.y + area.height - height));
  }
  return result;
}

// 桌宠改造：渲染进程手动拖拽时移动窗口（配合 preload 的 moveWindow）。
// 用 setBounds 移动窗口会触发窗口 move 事件，原有拖拽反应（live2d 视线/动作）继续生效。
function movePetWindow(x, y) {
  if (!petWindow || petWindow.isDestroyed()) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const bounds = petWindow.getBounds();
  const display = screen.getDisplayMatching({
    x: Math.round(x),
    y: Math.round(y),
    width: bounds.width,
    height: bounds.height
  });
  const area = display.workArea;
  const nx = Math.round(Math.min(Math.max(x, area.x), area.x + area.width - bounds.width));
  const ny = Math.round(Math.min(Math.max(y, area.y), area.y + area.height - bounds.height));
  petWindow.setBounds({ x: nx, y: ny, width: bounds.width, height: bounds.height });
  return true;
}

// ---------------------------------------------------------------------------
// 桌宠缩放（25%~200%，1% 粒度）：窗口尺寸与模型渲染同步；保持底边中心，避免缩放时“跑偏”
// ---------------------------------------------------------------------------
function currentSfw() {
  return sfwState(config, effectiveNsfwOverride()).sfw;
}

function petScaleBase() {
  const base = config && config.petWindowBase;
  if (base && Number(base.width) > 0 && Number(base.height) > 0) {
    return { width: Math.max(MIN_PET_WINDOW.width, Number(base.width)), height: Math.max(MIN_PET_WINDOW.height, Number(base.height)) };
  }
  const current = (config && config.petWindow) || {};
  const scale = Number((config && config.petScale) || 1) || 1;
  const width = Math.max(MIN_PET_WINDOW.width, Number(current.width || 520));
  const height = Math.max(MIN_PET_WINDOW.height, Number(current.height || 720));
  return { width: Math.round(width / scale), height: Math.round(height / scale) };
}

function petScaleInfo() {
  const bounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
  let workArea = null;
  try {
    const ref = bounds || (config && config.petWindow) || {};
    workArea = screen.getDisplayMatching(ref).workArea;
  } catch (e) {}
  return {
    scale: Math.round((Number(config.petScale || 1) || 1) * 100) / 100,
    base: petScaleBase(),
    bounds,
    workArea,
    min: PET_SCALE_MIN,
    max: PET_SCALE_MAX,
    step: 0.01,
    lastApply: lastScaleInfo
  };
}

function ensurePetScaleState() {
  if (config.petWindowBase) return config.petWindowBase;
  config = configStore.save({ petWindowBase: petScaleBase() });
  return config.petWindowBase;
}

function applyPetScale(scale) {
  let target = Number(scale);
  if (!Number.isFinite(target)) target = 1;
  target = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Math.round(target * 100) / 100));
  const base = petScaleBase();
  const refBounds = petWindow && !petWindow.isDestroyed()
    ? petWindow.getBounds()
    : {
        x: Number.isFinite(config.petWindow && config.petWindow.x) ? config.petWindow.x : 0,
        y: Number.isFinite(config.petWindow && config.petWindow.y) ? config.petWindow.y : 0,
        width: Number(config.petWindow && config.petWindow.width) || base.width,
        height: Number(config.petWindow && config.petWindow.height) || base.height
      };
  const display = screen.getDisplayMatching(refBounds);
  const area = display.workArea;
  let width = Math.round(base.width * target);
  let height = Math.round(base.height * target);
  let clamped = false;
  // 不超屏幕工作区（100% 正好等于工作区高度时允许，不额外留 2% 边距）
  const maxWidth = Math.max(MIN_PET_WINDOW.width, area.width);
  const maxHeight = Math.max(MIN_PET_WINDOW.height, area.height);
  let effective = target;
  if (width > maxWidth || height > maxHeight) {
    const factor = Math.min(maxWidth / width, maxHeight / height);
    effective = Math.max(PET_SCALE_MIN, Math.floor(target * factor * 100) / 100);
    width = Math.max(MIN_PET_WINDOW.width, Math.round(base.width * effective));
    height = Math.max(MIN_PET_WINDOW.height, Math.round(base.height * effective));
    clamped = true;
  }
  // 保持底边中心位置
  const centerX = refBounds.x + refBounds.width / 2;
  const bottomY = refBounds.y + refBounds.height;
  let x = Math.round(centerX - width / 2);
  let y = Math.round(bottomY - height);
  x = Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width));
  y = Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height));
  const patch = {
    petScale: effective,
    petWindowBase: base,
    petWindow: { x, y, width, height }
  };
  applyingPetScale = true;
  try {
    config = configStore.save(patch);
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setBounds({ x, y, width, height });
      petWindow.webContents.send("pet:resize", { width, height, scale: effective });
    }
  } finally {
    setTimeout(() => { applyingPetScale = false; }, 260);
  }
  lastScaleInfo = { scale: effective, requested: target, clamped, width, height, at: Date.now() };
  refreshTrayMenu();
  broadcast();
  return lastScaleInfo;
}

function fitPetScaleToScreen() {
  const base = petScaleBase();
  const ref = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : (config.petWindow || {});
  const display = screen.getDisplayMatching(ref);
  const area = display.workArea;
  const fit = Math.min(area.width / base.width, area.height / base.height);
  return applyPetScale(Math.min(1.2, Math.max(PET_SCALE_MIN, Math.floor(fit * 100) / 100)));
}

function zoomMenuItems() {
  const currentPct = Math.round((Number(config.petScale || 1) || 1) * 100);
  const items = [25, 50, 75, 100, 125, 150, 175, 200].map((pct) => ({
    label: pct + "%",
    type: "radio",
    checked: currentPct === pct,
    click: () => applyPetScale(pct / 100)
  }));
  items.push({ type: "separator" });
  items.push({ label: "＋5%", click: () => adjustPetScaleByPercent(5) });
  items.push({ label: "－5%", click: () => adjustPetScaleByPercent(-5) });
  items.push({ label: "＋1%（精细）", click: () => adjustPetScaleByPercent(1) });
  items.push({ label: "－1%（精细）", click: () => adjustPetScaleByPercent(-1) });
  items.push({ label: "重置 100%", click: () => applyPetScale(1) });
  items.push({ type: "separator" });
  items.push({ label: "适应屏幕", click: () => fitPetScaleToScreen() });
  return { label: "🔍 缩放（" + currentPct + "%）", submenu: items };
}

// ---------------------------------------------------------------------------
// 全局快捷键（globalShortcut）+ 快捷操作
// 说明：globalShortcut 在桌宠窗口失焦时依然生效；注册失败（被其它程序占用/组合键非法）
// 会记录原因并通过 rendererPayload 下发到管理页，方便用户改键。
// ---------------------------------------------------------------------------
function hotkeySetting() {
  return (config && config.hotkeys) || {};
}

// 按百分比调整缩放（1% 粒度；到边边界就不再变化）
function adjustPetScaleByPercent(delta) {
  const current = Math.round((Number(config.petScale || 1) || 1) * 100);
  const next = Math.min(200, Math.max(25, current + Math.round(Number(delta) || 0)));
  if (next === current) return petScaleInfo();
  return applyPetScale(next / 100);
}

// NSFW/SFW 快捷切换：与托盘菜单/管理页共用 setSfwEnabled（启动参数强制时不生效）
function toggleSfwHotkey() {
  const applied = setSfwEnabled(!currentSfw());
  if (!applied) {
    console.log("[main] hotkey toggleSfw ignored: nsfw forced by launch flag");
  }
  return applied;
}

function toggleAlwaysOnTopHotkey() {
  config = configStore.save({ alwaysOnTop: !Boolean(config.alwaysOnTop) });
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setAlwaysOnTop(Boolean(config.alwaysOnTop), "screen-saver");
  }
  refreshTrayMenu();
  broadcast();
  return Boolean(config.alwaysOnTop);
}

function togglePetHotkey() {
  const visible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
  if (visible) hidePet();
  else showPet();
  return !visible;
}

// 打开/关闭聊天记录面板：面板在宠物窗内，由渲染进程管理；同时聚焦输入框
function toggleChatPanel() {
  if (!petWindow || petWindow.isDestroyed()) {
    showPet();
  }
  if (!petWindow || petWindow.isDestroyed()) return false;
  if (!petWindow.isVisible()) petWindow.show();
  petWindow.webContents.send("pet:toggle-chat", { at: Date.now() });
  return true;
}

function hotkeyHandlers() {
  return {
    scaleUp: () => adjustPetScaleByPercent(hotkeySetting().step),
    scaleDown: () => adjustPetScaleByPercent(-hotkeySetting().step),
    scaleUpFine: () => adjustPetScaleByPercent(hotkeySetting().fineStep),
    scaleDownFine: () => adjustPetScaleByPercent(-hotkeySetting().fineStep),
    scaleReset: () => applyPetScale(1),
    toggleSfw: () => toggleSfwHotkey(),
    toggleAlwaysOnTop: () => toggleAlwaysOnTopHotkey(),
    togglePet: () => togglePetHotkey(),
    toggleChat: () => toggleChatPanel(),
    openManager: () => showManager()
  };
}

// 重新注册所有快捷键（config 变更 / 启动 / 手动刷新时调用）
// 改键失败的容错：旧键先记下来，新键注册失败时把旧键恢复回去——
// 否则用户改错一个键，不但新键不可用，原来能用的键也被 unregisterAll 清掉了。
function registerGlobalHotkeys() {
  const setting = hotkeySetting();
  const disabled = setting.enabled === false;
  const handlers = hotkeyHandlers();
  const previous = new Map(activeHotkeys);
  try {
    globalShortcut.unregisterAll();
  } catch (e) {}
  activeHotkeys = new Map();
  hotkeyStatus = [];
  const claimed = new Map(); // 本次已成功注册的 accelerator（小写）-> 动作名
  for (const action of HOTKEY_ACTIONS) {
    const accelerator = String(setting[action.id] || "").trim();
    const base = { id: action.id, name: action.name, detail: action.detail, accelerator, effective: "" };
    if (disabled) {
      hotkeyStatus.push({ ...base, registered: false, error: "已关闭全局快捷键" });
      continue;
    }
    if (!accelerator) {
      hotkeyStatus.push({ ...base, registered: false, error: "未设置" });
      continue;
    }
    const key = accelerator.toLowerCase();
    if (claimed.has(key)) {
      hotkeyStatus.push({ ...base, registered: false, error: "与「" + claimed.get(key) + "」重复" });
      continue;
    }
    let ok = false;
    let error = "";
    try {
      ok = globalShortcut.register(accelerator, handlers[action.id]);
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 160);
    }
    if (!ok && !error) error = "注册失败（可能被其它程序占用，或组合键无效）";
    if (ok) {
      claimed.set(key, action.name);
      activeHotkeys.set(action.id, accelerator);
      base.effective = accelerator;
    }
    hotkeyStatus.push({ ...base, registered: ok, error });
  }
  // 回滚：仅对「本来有旧键、这次用户确实改了键、新键没注册成功」的动作恢复旧键
  if (previous.size) {
    for (const item of hotkeyStatus) {
      if (item.registered) continue;
      const old = previous.get(item.id);
      if (!old) continue;
      const oldKey = old.toLowerCase();
      const unchanged = item.accelerator && item.accelerator.toLowerCase() === oldKey;
      if (unchanged) continue; // 旧键本身这次没注册成功，回滚也没意义
      if (claimed.has(oldKey)) {
        item.error = (item.error ? item.error + "；" : "") + "原快捷键已被其它动作占用";
        continue;
      }
      let restored = false;
      try {
        restored = globalShortcut.register(old, handlers[item.id]);
      } catch (e) {}
      if (restored) {
        claimed.set(oldKey, item.name);
        activeHotkeys.set(item.id, old);
        item.effective = old;
        item.rollback = old;
        item.registered = true;
        item.error = "";
      }
    }
  }
  hotkeyStatusAt = Date.now();
  const failed = hotkeyStatus.filter((item) => !item.registered && item.accelerator && !disabled);
  if (failed.length) console.warn("[main] hotkey registration failures:", failed.map((item) => `${item.id}=${item.accelerator} (${item.error})`).join("; "));
  return hotkeyStatus;
}

// 快捷键录制：在管理页按下组合键 → 主进程用 before-input-event 拼 accelerator。
// 渲染进程的 KeyboardEvent 会被输入法/键盘布局影响（尤其中文输入法），物理键状态更可靠。
// 录制期间 setSuspended(true)：否则用户按到已绑定组合键时，动作会被同时触发。
const ACCELERATOR_KEY_MAP = {
  " ": "Space",
  "+": "Plus",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  Escape: "Escape",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Insert: "Insert",
  Delete: "Delete",
  Backspace: "Backspace",
  Tab: "Tab",
  CapsLock: "Capslock",
  NumLock: "Numlock",
  ScrollLock: "Scrolllock"
};

function acceleratorKeyName(key) {
  if (!key) return "";
  if (ACCELERATOR_KEY_MAP[key]) return ACCELERATOR_KEY_MAP[key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  if (key.length === 1) return key;
  return "";
}

let hotkeyRecording = null;
function beginHotkeyRecording(timeoutMs) {
  if (hotkeyRecording) return hotkeyRecording.promise;
  const win = managerWindow && !managerWindow.isDestroyed()
    ? managerWindow
    : (petWindow && !petWindow.isDestroyed() ? petWindow : null);
  if (!win) return Promise.resolve({ ok: false, error: "设置窗口还没准备好" });
  const promise = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { win.webContents.removeListener("before-input-event", onInput); } catch (e) {}
      try { globalShortcut.setSuspended(false); } catch (e) {}
      hotkeyRecording = null;
      resolve(result);
    }
    function onInput(event, input) {
      if (!input || input.type !== "keyDown") return;
      if (input.isAutoRepeat) return;
      if (["Control", "Shift", "Alt", "Meta", "AltGraph", "Capslock", "Numlock"].indexOf(input.key) >= 0) return;
      if (input.key === "Escape") {
        event.preventDefault();
        finish({ ok: false, cancelled: true, error: "已取消" });
        return;
      }
      const keyName = acceleratorKeyName(input.key);
      if (!keyName) return;
      const mods = [];
      if (input.control) mods.push("CommandOrControl");
      if (input.alt) mods.push("Alt");
      if (input.shift) mods.push("Shift");
      if (input.meta) mods.push("Super");
      if (!mods.length) return; // 至少一个修饰键，避免抢普通打字
      event.preventDefault();
      finish({ ok: true, accelerator: mods.concat(keyName).join("+") });
    }
    try { globalShortcut.setSuspended(true); } catch (e) {}
    win.webContents.on("before-input-event", onInput);
    timer = setTimeout(function () {
      finish({ ok: false, error: "录制超时（10 秒），请重试" });
    }, Math.max(2000, Number(timeoutMs) || 10000));
  });
  hotkeyRecording = { promise: promise };
  return promise;
}

function hotkeyMenuItems() {
  const status = hotkeyStatus.length ? hotkeyStatus : registerGlobalHotkeys();
  const enabled = hotkeySetting().enabled !== false;
  const failures = status.filter((item) => item.accelerator && !item.registered && enabled);
  return {
    label: enabled
      ? (failures.length ? "⌨ 快捷键（" + failures.length + " 个冲突）" : "⌨ 快捷键")
      : "⌨ 快捷键（已关闭）",
    submenu: [
      ...status.map((item) => ({
        label: item.accelerator ? item.name + "  ·  " + item.accelerator : item.name + "  ·  （未设置）",
        enabled: false
      })),
      { type: "separator" },
      { label: "在管理页自定义…", click: showManager }
    ]
  };
}

// ---------------------------------------------------------------------------
// 场景目录（scene-catalog）：查找/启动保底/切换场景
// ---------------------------------------------------------------------------
function catalogEntryOf(model) {
  return entryForModel(sceneCatalog, model);
}

// 场景目录里的每模型 display.scale（辅助模型默认更小、全屏 CG 留边）合并进场景配置
function applyCatalogDisplayToScenes() {
  if (!sceneCatalog || !scenesConfig || !scenesConfig.models) return;
  for (const [modelId, entry] of Object.entries(scenesConfig.models)) {
    const cat = sceneCatalog.models[modelId];
    if (!cat || !cat.display) continue;
    const scale = cat.display.scale;
    if (scale !== null && scale !== undefined && Number.isFinite(Number(scale))) {
      if (entry.display.scale === null || entry.display.scale === undefined) {
        entry.display.scale = Number(scale);
      }
    }
  }
}

function loadCatalogForApp() {
  try {
    const loaded = loadSceneCatalog({ userDataDir: app.getPath("userData") });
    sceneCatalog = loaded.catalog;
    sceneCatalogPath = loaded.filePath;
    try { applyCatalogDisplayToScenes(); } catch (e) {}
    sceneCatalogInfo = {
      filePath: loaded.filePath,
      userFile: loaded.userFile,
      error: loaded.error,
      generatedAt: loaded.catalog && loaded.catalog.generatedAt,
      stats: null
    };
    try {
      sceneCatalogInfo.audit = auditCatalog(sceneCatalog, modelRegistry ? modelRegistry.list() : []);
    } catch (error) {
      sceneCatalogInfo.audit = { error: String((error && error.message) || error) };
    }
    return sceneCatalogInfo;
  } catch (error) {
    sceneCatalogInfo = { error: String((error && error.message) || error) };
    return sceneCatalogInfo;
  }
}

// 角色注册表：内置 characters.json + 用户覆盖 user-data/characters.json
function loadCharactersForApp() {
  try {
    const loaded = loadCharacters({ userDataDir: app.getPath("userData") });
    characterRegistry = loaded.registry;
    characterRegistryInfo = {
      filePath: loaded.filePath,
      userFile: loaded.userFile,
      error: loaded.error,
      stats: characterRegistry ? characterRegistry.stats : null,
      duplicateModelIds: characterRegistry ? characterRegistry.duplicateModelIds : []
    };
    return characterRegistryInfo;
  } catch (error) {
    characterRegistry = null;
    characterRegistryInfo = { error: String((error && error.message) || error) };
    return characterRegistryInfo;
  }
}

// 当前选中模型对应哪个角色、实际使用哪张角色卡（调试/自动化可查询，不触发任何外部请求）
function activeCharacterInfo() {
  const model = selectedModel();
  const tavern = (config && config.tavern) || {};
  const resolved = resolveCharacterPrompt(characterRegistry, model, tavern.rolePrompt || "");
  return {
    modelId: model ? model.id : "",
    modelName: model ? (model.name || model.displayName || model.id) : "",
    game: model ? (model.game || "") : "",
    characterId: resolved.characterId,
    characterName: resolved.character ? resolved.character.name : "",
    prompt: resolved.prompt,
    promptPreview: resolved.prompt.slice(0, 120),
    source: resolved.source,
    overridden: resolved.overridden,
    charactersFile: characterRegistryInfo ? characterRegistryInfo.filePath : "",
    userFile: characterRegistryInfo ? characterRegistryInfo.userFile : ""
  };
}

// 启动默认模型保底：若 lastModel 是辅助/剖面模型（SFW 下），回退到同游戏立绘
function guardStartupModel() {
  try {
    if (!sceneCatalog || !modelRegistry) return { changed: false, reason: "catalog_missing" };
    const models = modelRegistry.list();
    const resolved = resolveStartupModel(sceneCatalog, models, {
      selectedModelId: config.selectedModelId,
      sfw: currentSfw()
    });
    if (resolved.fallbackApplied && resolved.selectedModelId && resolved.selectedModelId !== config.selectedModelId) {
      const from = config.selectedModelId;
      config = configStore.save({ selectedModelId: resolved.selectedModelId });
      return { changed: true, from, to: config.selectedModelId, reason: resolved.reason, fallbackModel: resolved.fallbackModel };
    }
    return { changed: false, selectedModelId: config.selectedModelId, reason: resolved.reason };
  } catch (error) {
    return { changed: false, error: String((error && error.message) || error) };
  }
}

// 切换场景 = 切换模型 + 播放代表场景（渲染进程等模型加载完成后再执行动作）
function playCatalogScene(payload) {
  const modelId = String((payload && payload.modelId) || "");
  const sceneId = String((payload && payload.sceneId) || "");
  if (!modelRegistry) return { ok: false, reason: "not_ready" };
  const target = modelRegistry.get(modelId);
  if (!target) return { ok: false, reason: "model_not_found", modelId };
  const entry = catalogEntryOf(target);
  if (!entry) return { ok: false, reason: "catalog_entry_not_found", modelId };
  if (entry.kind === "auxiliary" && currentSfw()) {
    return { ok: false, reason: "nsfw_required", message: "辅助视角模型（非人物立绘）需要先开启 NSFW 才能启用", modelId };
  }
  if (entry.nsfwOnly && currentSfw()) {
    return { ok: false, reason: "nsfw_required", message: "该场景为 NSFW 限定，请先在托盘菜单开启 NSFW", modelId };
  }
  rememberModelSwitch(modelId);
  config = configStore.save({ selectedModelId: modelId });
  const targetScene = sceneId || entry.defaultScene || "idle";
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("pet:catalog-scene", {
      modelId,
      sceneId: targetScene,
      entry: {
        sceneLabel: entry.sceneLabel,
        category: entry.category,
        kind: entry.kind,
        nsfwOnly: entry.nsfwOnly,
        whenToUse: entry.whenToUse
      },
      at: Date.now()
    });
  }
  refreshTrayMenu();
  broadcast();
  return { ok: true, modelId, sceneId: targetScene, sceneLabel: entry.sceneLabel, kind: entry.kind, entry };
}

function createPetWindow() {
  const bounds = resolvePetWindowBounds(config.petWindow || {});
  petWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_PET_WINDOW.width,
    minHeight: MIN_PET_WINDOW.height,
    x: Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: Number.isFinite(bounds.y) ? bounds.y : undefined,
    frame: false,
    transparent: true,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    alwaysOnTop: Boolean(config.alwaysOnTop),
    opacity: Number(config.opacity || 1),
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 桌宠窗口始终动画（即使被管理窗口遮挡也保持 60fps，避免 SFW 过渡/动作冻结）
      backgroundThrottling: false
    }
  });

  petWindow.loadFile(rendererFile(), { query: { view: "pet" } });

  petWindow.once("ready-to-show", () => {
    keepPetOnTop();
    if (config.petVisible && !userHidden) {
      petWindow.show();
      petWindow.moveTop();
    }
    if (process.env.DAIDAI_TAVERN_SELFTEST === "1") {
      setTimeout(() => {
        if (!petWindow || petWindow.isDestroyed()) return;
        petWindow.webContents.executeJavaScript(`
          (async function () {
            for (let i = 0; i < 50; i += 1) {
              if (window.__sendTavernMessage) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!window.__sendTavernMessage) throw new Error("tavern sender not ready");
            await window.__sendTavernMessage("老公测试一下");
            return true;
          })();
        `).catch((error) => {
          const file = path.join(app.getPath("userData"), "renderer-error.log");
          fs.appendFileSync(file, `${new Date().toISOString()} selftest ${error.message || error}\n`, "utf8");
        });
      }, 1000);
    }
  });
  petWindow.on("resize", () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(savePetBounds, 200);
  });
  petWindow.on("move", () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const now = Date.now();
    const bounds = petWindow.getBounds();
    const previous = lastMoveBounds || bounds;
    const elapsed = Math.max(16, now - (lastMoveAt || now));
    const dx = bounds.x - previous.x;
    const dy = bounds.y - previous.y;
    lastMoveBounds = bounds;
    lastMoveAt = now;
    if (!dx && !dy) return;

    petWindow.webContents.send("pet:drag-state", {
      active: true,
      dragging: true,
      dx,
      dy,
      vx: dx / elapsed,
      vy: dy / elapsed,
      at: now
    });
    clearTimeout(dragEndTimer);
    dragEndTimer = setTimeout(() => {
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send("pet:drag-state", {
          active: false,
          dragging: false,
          dx: 0,
          dy: 0,
          vx: 0,
          vy: 0,
          at: Date.now()
        });
      }
      savePetBounds();
    }, 180);
  });
  lastMoveBounds = petWindow.getBounds();
  lastMoveAt = Date.now();
}

function createManagerWindow() {
  managerWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: "Daidai Live2D Pet 管理",
    icon: appIcon(),
    // 管理窗曾经出现「内容左侧被裁、右侧一块深色空白」：渲染进程页面被 Ctrl+滚轮缩放到
    // 125% 后 Chromium 只按缩小后的布局视口绘制，窗口剩余区域保持未重绘。这里固定背景色，
    // 并在每次加载/显示时把页面缩放重置为 1（manager-guard.js 同时拦截 Ctrl+滚轮）。
    backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 初始缩放固定 100%：页面缩放 !=100% 时 Chromium 会按缩小后的布局视口绘制，
      // 窗口剩余区域不重绘，表现为“左半边内容被裁、右侧一块空白”。
      zoomFactor: 1
    }
  });
  managerWindow.loadFile(rendererFile(), { query: { view: "manager" } });
  const resetManagerZoom = () => {
    try {
      if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.setZoomFactor(1);
    } catch (e) {}
  };
  managerWindow.webContents.on("did-finish-load", resetManagerZoom);
  managerWindow.webContents.on("did-stop-loading", resetManagerZoom);
  // Ctrl+滚轮/触控板缩放请求：立即复位，管理页不允许页面缩放
  managerWindow.webContents.on("zoom-changed", resetManagerZoom);
  // 系统 DPI/显示器缩放变化后 Chromium 可能保留错误的页面缩放，主动复位一次
  managerWindow.on("resize", () => {
    try {
      if (managerWindow.webContents.getZoomFactor() !== 1) managerWindow.webContents.setZoomFactor(1);
    } catch (e) {}
  });
  managerWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      managerWindow.hide();
    }
  });
}

function showManager() {
  if (!managerWindow || managerWindow.isDestroyed()) createManagerWindow();
  try {
    // 兜底：隐藏期间页面缩放被改过，显示前恢复，避免再次出现半幅渲染
    managerWindow.webContents.setZoomFactor(1);
  } catch (e) {}
  managerWindow.show();
  managerWindow.focus();
}

function showPet() {
  userHidden = false;
  config = configStore.save({ petVisible: true });
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  keepPetOnTop();
  petWindow.show();
  petWindow.moveTop();
  broadcast();
}

function hidePet() {
  userHidden = true;
  config = configStore.save({ petVisible: false });
  if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
  broadcast();
}

// ---------------------------------------------------------------------------
// 场景系统：scenes.json + 场景面板窗口 + 托盘快捷场景 + 命令转发
// ---------------------------------------------------------------------------
function scenesFile() {
  return path.join(__dirname, "..", "renderer", "scenes.html");
}

function currentScenes() {
  return getModelScenes(scenesConfig, config && config.selectedModelId);
}

function createScenesWindow() {
  scenesWindow = new BrowserWindow({
    width: 780,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: "Daidai · 动作与场景",
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  scenesWindow.loadFile(scenesFile());
  scenesWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      scenesWindow.hide();
    }
  });
  scenesWindow.on("closed", () => {
    scenesWindow = null;
  });
}

function showScenes() {
  if (!scenesWindow || scenesWindow.isDestroyed()) createScenesWindow();
  scenesWindow.show();
  scenesWindow.focus();
}

function hideScenesPanel() {
  if (scenesWindow && !scenesWindow.isDestroyed()) scenesWindow.hide();
}

// 把场景命令发给宠物窗渲染进程执行（托盘 / 面板 / 调试共用）
function sendSceneCommand(payload) {
  if (!payload) return false;
  if (!petWindow || petWindow.isDestroyed()) return false;
  if (!petWindow.isVisible()) showPet();
  petWindow.webContents.send("pet:scene-command", {
    id: payload.id || "",
    reset: Boolean(payload.reset),
    source: payload.source || "tray",
    at: Date.now()
  });
  return true;
}

// 托盘快捷场景：按分类挑 3~5 个常用场景；实验性（启发式半脱）默认不进快捷/随机
function trayQuickSceneItems() {
  const scenes = (currentScenes().scenes || []).filter((scene) => !scene.experimental);
  if (!scenes.length) return [];
  const picked = [];
  const seenCategories = new Set();
  for (const category of ["换装", "情绪", "日常"]) {
    const scene = scenes.find((item) => item.category === category && !picked.includes(item));
    if (scene) {
      picked.push(scene);
      seenCategories.add(category);
    }
  }
  for (const scene of scenes) {
    if (picked.length >= 4) break;
    if (!picked.includes(scene)) picked.push(scene);
  }
  return picked.slice(0, 4).map((scene) => ({
    label: `▶ ${scene.label}`,
    click: () => sendSceneCommand({ id: scene.id, source: "tray" })
  }));
}

function randomSceneId() {
  const scenes = (currentScenes().scenes || []).filter((scene) => !scene.experimental);
  if (!scenes.length) return "";
  return scenes[Math.floor(Math.random() * scenes.length)].id;
}

function openScenesConfig() {
  if (!scenesFilePath) return false;
  shell.openPath(scenesFilePath);
  return true;
}

// 场景配置合并：手工 scenes.json（优先）+ 自动生成 scenes.generated.json（补缺）
// + model-display.json / 旧 config.hiddenParts（每模型 display.scale / hiddenParts 覆盖）
function loadAllScenes() {
  const baseFile = scenesFilePath || path.join(app.getAppPath(), "config", "scenes.json");
  scenesGeneratedFilePath = path.join(app.getPath("userData"), "scenes.generated.json");
  modelDisplayFilePath = path.join(app.getPath("userData"), "model-display.json");
  const base = loadScenesConfig(baseFile);
  const generated = loadScenesConfig(scenesGeneratedFilePath);
  const display = readModelDisplayOverrides(app.getPath("userData"));
  const merged = mergeScenesConfigs(
    base.config,
    generated.config,
    display.models,
    (config && config.hiddenParts) || {},
    (config && config.hiddenDrawables) || {}
  );
  scenesConfig = merged;
  try { applyCatalogDisplayToScenes(); } catch (e) {}
  if (base.error) console.error("[main] scenes.json load failed:", base.error);
  if (generated.error) console.warn("[main] scenes.generated.json load failed:", generated.error);
  return { base, generated, display, merged };
}

function reloadScenesConfig() {
  const loaded = loadAllScenes();
  refreshTrayMenu();
  broadcast();
  return loaded.generated.error ? { filePath: scenesFilePath, config: scenesConfig, error: loaded.generated.error } : { filePath: scenesFilePath, config: scenesConfig, error: null };
}


// 托盘 SFW 勾选/取消：保存用户选择（N 下次启动仍生效），刷新菜单并通知渲染层。
// 启动参数强制模式下拒绝修改，避免测试截图污染用户配置。
function setSfwEnabled(sfwEnabled) {
  if (nsfwOverride !== null) return false;
  config = configStore.save({ nsfwMode: !sfwEnabled });
  refreshTrayMenu();
  broadcast();
  return true;
}

// SFW/NSFW 托盘菜单项：勾选状态 = 毛玻璃遮罩是否开启（默认开）。
// 启动参数强制模式时禁用开关并标注，避免测试截图误改用户持久化配置。
function sfwMenuItem() {
  const state = sfwState(config, effectiveNsfwOverride());
  const forcedNsfw = state.forced === true;
  const forcedSfw = state.forced === false;
  let label;
  if (state.sfw) {
    label = forcedSfw ? "🔒 SFW 毛玻璃：开（启动参数强制）" : "🔒 SFW 毛玻璃：开（点击切到 NSFW 清晰）";
  } else {
    label = forcedNsfw ? "🔓 NSFW 清晰：开（启动参数强制，测试模式）" : "🔓 NSFW 清晰：开（点击恢复 SFW 毛玻璃）";
  }
  return {
    label,
    type: "checkbox",
    checked: state.sfw,
    enabled: state.forced === null,
    click: (item) => setSfwEnabled(item.checked)
  };
}

function trayTooltip() {
  const state = sfwState(config, effectiveNsfwOverride());
  const suffix = state.sfw ? "SFW 毛玻璃" : "NSFW 清晰";
  return `Daidai Live2D Pet · ${suffix}${state.forced !== null ? "（启动参数强制）" : ""}`;
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(trayTooltip());
  trayMenu = Menu.buildFromTemplate([
      { label: "显示桌宠", click: showPet },
      { label: "隐藏桌宠", click: hidePet },
      { label: "打开管理", click: showManager },
      { type: "separator" },
      {
        label: "总在最前",
        type: "checkbox",
        checked: Boolean(config.alwaysOnTop),
        click: (item) => {
          config = configStore.save({ alwaysOnTop: item.checked });
          if (petWindow && !petWindow.isDestroyed()) {
            petWindow.setAlwaysOnTop(Boolean(config.alwaysOnTop), "screen-saver");
          }
          broadcast();
        }
      },
      { type: "separator" },
      zoomMenuItems(),
      { label: "💬 聊天记录面板", click: () => toggleChatPanel() },
      hotkeyMenuItems(),
      { type: "separator" },
      sfwMenuItem(),
      { type: "separator" },
      { label: "🎬 动作与场景…", click: showScenes },
      ...trayQuickSceneItems(),
      {
        label: randomSceneId() ? "🎲 随机场景" : "🎲 随机场景（当前模型无场景）",
        enabled: Boolean(randomSceneId()),
        click: () => sendSceneCommand({ id: randomSceneId(), source: "tray" })
      },
      {
        label: "🤖 AI 对话自动切换场景",
        type: "checkbox",
        checked: config.sceneAutoEnabled !== false,
        click: (item) => {
          config = configStore.save({ sceneAutoEnabled: Boolean(item.checked) });
          refreshTrayMenu();
          broadcast();
        }
      },
      { label: "⚙ 打开场景配置 scenes.json", click: openScenesConfig },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ]);
  tray.setContextMenu(trayMenu);
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip(trayTooltip());
  refreshTrayMenu();
  tray.on("double-click", showManager);
}

function startCursorForwarding() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
    const point = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    petWindow.webContents.send("pet:cursor-position", {
      x: point.x - bounds.x,
      y: point.y - bounds.y,
      width: bounds.width,
      height: bounds.height,
      point,
      bounds
    });
  }, 50);
}

// Tavern: configurable chat + voice settings live in config.json.
let _tavernAbortController = null;
const VOLC_TTS_URL = "https://openspeech.bytedance.com/api/v1/tts";

function tavernChatPath() {
  const dir = path.join(app.getPath("userData"), "tavern");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tavernLog(message, payload) {
  try {
    const file = path.join(app.getPath("userData"), "tavern.log");
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}${payload ? ` ${JSON.stringify(payload)}` : ""}\n`, "utf8");
  } catch {}
}

function spokenTextOnly(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_~`#>-]/g, "")
    .replace(/[（(][^（）()]{0,80}[）)]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function registerIpc() {
  ipcMain.handle("app:get-state", () => rendererPayload());
  // 管理页渲染兜底：页面若被 Chromium 缩放到 !=100%（Ctrl+滚轮 / DPI 切换），
  // manager-guard.js 会调用这里复位，避免只绘制半幅内容（用户反馈的裁切/空白问题）。
  ipcMain.handle("app:reset-manager-zoom", () => {
    try {
      if (managerWindow && !managerWindow.isDestroyed()) {
        managerWindow.webContents.setZoomFactor(1);
        return { ok: true, zoomFactor: managerWindow.webContents.getZoomFactor() };
      }
    } catch (e) {}
    return { ok: false };
  });
  ipcMain.handle("app:renderer-error", (_event, payload) => {
    try {
      const file = path.join(app.getPath("userData"), "renderer-error.log");
      fs.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(payload)}\n`, "utf8");
    } catch {}
    return true;
  });
  ipcMain.handle("app:set-config", (_event, patch) => {
    const previousBaseUrl = (config && config.tavern && config.tavern.textBaseUrl) || "";
    const patchScale = patch && patch.petScale !== undefined ? Number(patch.petScale) : null;
    config = configStore.save(patch || {});
    // 切换聊天接口地址后重新尝试 function calling（之前可能因接口不支持而回退过）
    if (patch && patch.tavern && patch.tavern.textBaseUrl !== undefined && patch.tavern.textBaseUrl !== previousBaseUrl) {
      toolsUnsupported = false;
    }
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setAlwaysOnTop(Boolean(config.alwaysOnTop), "screen-saver");
      petWindow.setOpacity(Number(config.opacity || 1));
    }
    // 缩放：管理页滑块 / 托盘 / Ctrl+滚轮 都走同一套窗口尺寸重算
    if (patchScale !== null && Number.isFinite(patchScale)) {
      applyPetScale(patchScale);
    }
    // 管理页改了快捷键配置：立即重新注册（失败的项会出现在 hotkeyStatus 里）
    if (patch && patch.hotkeys) {
      registerGlobalHotkeys();
    }
    // 管理页也能切换 SFW，同步托盘勾选状态与提示
    refreshTrayMenu();
    broadcast();
    return rendererPayload();
  });
  // 调试钩子：把托盘菜单弹出来，方便自动化截图/人工核对 SFW 开关位置
  if (DEBUG_HOOKS) {
    ipcMain.handle("app:debug-show-tray-menu", () => {
      if (!tray || tray.isDestroyed()) return false;
      tray.popUpContextMenu();
      return true;
    });
    // 托盘菜单结构快照：自动化验证开关文案/勾选/禁用状态（无 GUI 截图依赖）
    ipcMain.handle("app:debug-tray-snapshot", () => ({
      items: (trayMenu ? trayMenu.items : []).map((item) => ({
        label: item.label,
        type: item.type,
        checked: Boolean(item.checked),
        enabled: item.enabled !== false
      }))
    }));
    // 用托盘菜单的真实点击回调切换 SFW（与用户点勾选项走同一条代码路径）
    ipcMain.handle("app:debug-tray-toggle-sfw", () => {
      if (!trayMenu) return { ok: false, error: "tray menu not ready" };
      const item = trayMenu.items.find(
        (entry) => typeof entry.label === "string" && (entry.label.includes("SFW 毛玻璃") || entry.label.includes("NSFW 清晰"))
      );
      if (!item) return { ok: false, error: "sfw menu item not found" };
      if (item.enabled === false) return { ok: false, error: "disabled (forced by launch flag)" };
      const before = sfwState(config, effectiveNsfwOverride());
      const applied = setSfwEnabled(!before.sfw);
      const snapshot = (trayMenu ? trayMenu.items : []).map((entry) => ({
        label: entry.label,
        type: entry.type,
        checked: Boolean(entry.checked),
        enabled: entry.enabled !== false
      }));
      return {
        ok: Boolean(applied),
        clickedLabel: item.label,
        before: { sfw: before.sfw, nsfw: before.nsfw },
        savedNsfwMode: Boolean(config && config.nsfwMode),
        applied: sfwState(config, effectiveNsfwOverride()),
        menu: snapshot
      };
    });
    ipcMain.handle("app:debug-show-manager", () => {
      showManager();
      return true;
    });
    ipcMain.handle("app:debug-hide-manager", () => {
      if (managerWindow && !managerWindow.isDestroyed()) managerWindow.hide();
      return true;
    });
    // 场景系统调试：面板打开 / 场景信息 / 模拟托盘点击场景
    ipcMain.handle("app:debug-open-scene-panel", () => {
      showScenes();
      return true;
    });
    ipcMain.handle("app:debug-scene-info", () => {
      const info = currentScenes();
      return {
        path: scenesFilePath,
        modelId: (config && config.selectedModelId) || "",
        sceneCount: info.scenes.length,
        scenes: info.scenes.map((scene) => ({ id: scene.id, label: scene.label, category: scene.category, priority: scene.priority })),
        lastSceneState,
        trayItems: (trayMenu ? trayMenu.items : []).map((item) => ({
          label: item.label,
          type: item.type,
          checked: Boolean(item.checked),
          enabled: item.enabled !== false
        }))
      };
    });
    ipcMain.handle("app:debug-tray-scene", (_event, sceneId) => {
      const info = currentScenes();
      const scene = info.scenes.find((item) => item.id === sceneId);
      if (!scene) return { ok: false, error: "scene not found: " + sceneId };
      const sent = sendSceneCommand({ id: scene.id, source: "tray" });
      return { ok: sent, scene: { id: scene.id, label: scene.label } };
    });
    // AI 控制调试：能力清单 / 工具支持状态
    ipcMain.handle("app:debug-capabilities", () => lastCapabilities);
    ipcMain.handle("app:debug-ai-state", () => ({
      toolsUnsupported,
      hasCapabilities: Boolean(lastCapabilities),
      modelId: lastCapabilities && lastCapabilities.model_id,
      tools: lastCapabilities && (lastCapabilities.tools || []).map((tool) => tool.function && tool.function.name)
    }));
    // 自动化测试用：直接设置宠物窗大小/位置（不影响用户启动路径）
    ipcMain.handle("app:debug-set-pet-bounds", (_event, bounds) => {
      if (!petWindow || petWindow.isDestroyed() || !bounds) return false;
      const current = petWindow.getBounds();
      const next = {
        width: Math.max(MIN_PET_WINDOW.width, Number(bounds.width) || current.width),
        height: Math.max(MIN_PET_WINDOW.height, Number(bounds.height) || current.height),
        x: Number.isFinite(Number(bounds.x)) ? Number(bounds.x) : current.x,
        y: Number.isFinite(Number(bounds.y)) ? Number(bounds.y) : current.y
      };
      petWindow.setBounds(next);
      savePetBounds();
      return petWindow.getBounds();
    });
    // 缩放/场景目录自动化辅助
    ipcMain.handle("app:debug-pet-bounds", () => {
      const bounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
      return { bounds, petScale: petScaleInfo() };
    });
    // 全局快捷键：查询注册结果 / 通过真实动作函数触发（不依赖 OS 级按键注入）
    ipcMain.handle("app:debug-hotkeys", () => ({
      status: hotkeyStatus,
      at: hotkeyStatusAt,
      enabled: hotkeySetting().enabled !== false,
      config: hotkeySetting()
    }));
    ipcMain.handle("app:debug-trigger-hotkey", (_event, id) => {
      const handlers = hotkeyHandlers();
      if (!handlers[id]) return { ok: false, error: "unknown hotkey action: " + id };
      try {
        const result = handlers[id]();
        return { ok: true, id, result };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
    // 聊天历史自动化辅助：查文件 / 查记录
    ipcMain.handle("app:debug-chat-history", (_event, characterId) => {
      if (!chatHistory) return { error: "chat history store not ready" };
      return { file: chatHistory.file, entries: chatHistory.load(characterId), stats: chatHistory.stats() };
    });
    ipcMain.handle("app:debug-catalog-audit", () => {
      if (!sceneCatalog) return { error: "catalog not loaded" };
      const audit = auditCatalog(sceneCatalog, modelRegistry.list());
      return {
        filePath: sceneCatalogPath,
        userFile: sceneCatalogInfo && sceneCatalogInfo.userFile,
        stats: sceneCatalog.stats || null,
        audit,
        catalog: sceneCatalog
      };
    });
    ipcMain.handle("app:debug-startup-guard", () => guardStartupModel());
    ipcMain.handle("app:debug-catalog-entry", (_event, modelId) => {
      const target = modelRegistry.get(modelId);
      if (!target) return null;
      return catalogEntryOf(target);
    });
    // 当前模型 → 角色 → 实际使用的角色卡提示词（不联网，用于自动化/排障）
    ipcMain.handle("app:debug-active-character", () => activeCharacterInfo());
    // 当前模型的普通场景池（排除实验性半脱）；用于验证默认随机池不含实验性场景
    ipcMain.handle("app:debug-scene-pool", () => {
      const info = currentScenes();
      const scenes = info.scenes || [];
      return {
        modelId: info.modelId,
        all: scenes.map((s) => ({ id: s.id, label: s.label, category: s.category, experimental: Boolean(s.experimental) })),
        defaultPool: scenes.filter((s) => !s.experimental).map((s) => s.id),
        randomPick: randomSceneId(),
        experimental: scenes.filter((s) => s.experimental).map((s) => s.id)
      };
    });
    ipcMain.handle("app:debug-scale-apply", (_event, scale) => applyPetScale(Number(scale)));
    ipcMain.handle("app:debug-scale-fit", () => fitPetScaleToScreen());
    // 自动化测试：临时改 100% 基准窗口尺寸（用于在小屏幕上演示 150% 档；不改变用户配置语义）
    ipcMain.handle("app:debug-set-scale-base", (_event, base) => {
      if (!base) return petScaleInfo();
      const width = Math.max(MIN_PET_WINDOW.width, Number(base.width) || 1000);
      const height = Math.max(MIN_PET_WINDOW.height, Number(base.height) || 816);
      config = configStore.save({ petWindowBase: { width, height } });
      broadcast();
      return petScaleInfo();
    });
    // 会话内临时切换 NSFW（不写 config.json；供自动化测试主进程侧 gating 使用）
    ipcMain.handle("app:debug-set-main-nsfw", (_event, value) => {
      debugMainNsfwOverride = value === null || value === undefined ? null : Boolean(value);
      refreshTrayMenu();
      broadcast();
      return { sfw: currentSfw(), override: debugMainNsfwOverride };
    });
    // 托盘「🔍 缩放」子菜单：结构快照 + 用真实菜单项点击回调触发（与用户点菜单同一代码路径）
    ipcMain.handle("app:debug-zoom-menu", () => {
      const root = (trayMenu ? trayMenu.items : []).find(
        (item) => typeof item.label === "string" && item.label.indexOf("缩放") >= 0
      );
      const submenu = root && root.submenu ? root.submenu.items : [];
      return {
        root: root ? { label: root.label, type: root.type } : null,
        items: submenu.map((item) => ({
          label: item.label,
          type: item.type,
          checked: Boolean(item.checked),
          enabled: item.enabled !== false
        }))
      };
    });
    ipcMain.handle("app:debug-tray-zoom", (_event, label) => {
      const root = (trayMenu ? trayMenu.items : []).find(
        (item) => typeof item.label === "string" && item.label.indexOf("缩放") >= 0
      );
      const submenu = root && root.submenu ? root.submenu.items : [];
      const wanted = String(label || "");
      const item = submenu.find((entry) => {
        if (typeof entry.label !== "string") return false;
        if (wanted === "适应屏幕") return entry.label.indexOf("适应屏幕") >= 0;
        return entry.label.indexOf(wanted) === 0;
      });
      if (!item) return { ok: false, error: "zoom menu item not found", label: wanted, available: submenu.map((e) => e.label) };
      if (typeof item.click !== "function") return { ok: false, error: "zoom menu item has no click handler", label: item.label };
      item.click(item, petWindow, {});
      return { ok: true, clickedLabel: item.label, scale: petScaleInfo() };
    });
    // 截取宠物窗并统计透明通道（默认背景透明验证）；返回整体/四角不透明像素比例 + 可见像素包围盒
    ipcMain.handle("app:debug-capture-alpha", async (_event, filePath) => {
      try {
        const image = await petWindow.webContents.capturePage();
        const size = image.getSize();
        const bitmap = image.toBitmap();
        const total = size.width * size.height;
        let opaque = 0;
        let cornerTotal = 0;
        let cornerOpaque = 0;
        let minX = size.width;
        let minY = size.height;
        let maxX = -1;
        let maxY = -1;
        const cw = Math.max(1, Math.floor(size.width * 0.2));
        const ch = Math.max(1, Math.floor(size.height * 0.2));
        for (let y = 0; y < size.height; y += 1) {
          const inCornerRow = y < ch || y >= size.height - ch;
          for (let x = 0; x < size.width; x += 1) {
            const idx = (y * size.width + x) * 4;
            const a = bitmap[idx + 3];
            if (a > 16) {
              opaque += 1;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
            if (inCornerRow && (x < cw || x >= size.width - cw)) {
              cornerTotal += 1;
              if (a > 16) cornerOpaque += 1;
            }
          }
        }
        const bbox = maxX >= 0
          ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
          : null;
        if (filePath) {
          fs.mkdirSync(path.dirname(path.resolve(String(filePath))), { recursive: true });
          fs.writeFileSync(path.resolve(String(filePath)), image.toPNG());
        }
        return {
          ok: true,
          size,
          file: filePath || null,
          opaqueFraction: total ? opaque / total : 0,
          cornerOpaqueFraction: cornerTotal ? cornerOpaque / cornerTotal : 0,
          bbox,
          bboxPct: bbox
            ? {
                left: bbox.x / size.width,
                top: bbox.y / size.height,
                right: (bbox.x + bbox.width) / size.width,
                bottom: (bbox.y + bbox.height) / size.height
              }
            : null
        };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    });
  }
  // 场景系统 IPC：面板/托盘 -> 宠物窗执行；宠物窗回报执行状态
  ipcMain.handle("scene:play", (_event, payload) => {
    const sceneId = typeof payload === "string" ? payload : (payload && payload.id) || "";
    const source = (payload && payload.source) || "panel";
    const ok = sendSceneCommand({ id: sceneId, source });
    return { ok, sceneId };
  });
  ipcMain.handle("scene:reset", (_event, payload) => {
    const source = (payload && payload.source) || "panel";
    const ok = sendSceneCommand({ reset: true, source });
    return { ok };
  });
  ipcMain.handle("scene:state", (_event, payload) => {
    lastSceneState = payload || null;
    if (scenesWindow && !scenesWindow.isDestroyed()) {
      scenesWindow.webContents.send("pet:scene-state", lastSceneState);
    }
    return true;
  });
  ipcMain.handle("scene:open-config", () => openScenesConfig());
  ipcMain.handle("scene:reload", () => {
    const loaded = reloadScenesConfig();
    return { ok: !loaded.error, error: loaded.error };
  });
  ipcMain.handle("scene:close-panel", () => {
    hideScenesPanel();
    return true;
  });
  // 渲染进程上报当前模型能力清单（每次切模型/改场景配置后）
  ipcMain.handle("pet:capabilities", (_event, payload) => {
    lastCapabilities = payload || null;
    return true;
  });
  // 渲染进程回传工具调用结果
  ipcMain.handle("pet:tool-result", (_event, payload) => {
    const requestId = payload && payload.requestId;
    if (!requestId) return false;
    const resolver = pendingToolCalls.get(requestId);
    if (resolver) {
      pendingToolCalls.delete(requestId);
      resolver(payload.result);
    }
    return true;
  });
  ipcMain.handle("model:import-directory", async () => {
    const result = await dialog.showOpenDialog(managerWindow || undefined, {
      title: "选择 Live2D 模型目录",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths.length) return rendererPayload();
    const record = modelRegistry.importDirectory(result.filePaths[0]);
    rememberModelSwitch(record.id);
    config = configStore.save({ selectedModelId: record.id });
    broadcast();
    return rendererPayload();
  });
  ipcMain.handle("model:select", (_event, modelId) => {
    const target = modelRegistry.get(modelId);
    if (!target) throw new Error(`Model not found: ${modelId}`);
    const entry = catalogEntryOf(target);
    // 辅助/剖面模型只在 NSFW 开启时允许启用（SFW 下禁止切换，返回 selectError 供 UI 提示）
    if (entry && entry.kind === "auxiliary" && currentSfw()) {
      const payload = rendererPayload();
      payload.selectError = {
        reason: "nsfw_required",
        modelId,
        message: "「" + (entry.sceneLabel || target.name) + "」是辅助视角模型（非人物立绘），请先在托盘菜单开启 NSFW 再启用"
      };
      return payload;
    }
    rememberModelSwitch(modelId);
    config = configStore.save({ selectedModelId: modelId });
    broadcast();
    return rendererPayload();
  });
  ipcMain.handle("model:open-directory", async () => {
    await shell.openPath(modelRegistry.openDirectoryPath());
    return rendererPayload();
  });
  ipcMain.handle("model:open-sounds-directory", async () => {
    const dir = path.join(app.getPath("userData"), "sounds");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return rendererPayload();
  });
  // 重新扫描模型库：更新 models.json + scenes.generated.json（根目录来自配置/环境变量）
  ipcMain.handle("model:rescan", () => {
    let info = null;
    try {
      info = modelRegistry.rescanLibrary(modelLibrarySettings());
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    // 扫描后若当前选中的模型已不存在（例如模型库路径被移动），自动切到第一个可用模型
    const models = modelRegistry.list();
    if (models.length && (!config.selectedModelId || !modelRegistry.get(config.selectedModelId))) {
      rememberModelSwitch(models[0].id);
      config = configStore.save({ selectedModelId: models[0].id });
    }
    loadAllScenes();
    refreshTrayMenu();
    broadcast();
    return { ok: true, info, state: rendererPayload() };
  });
  ipcMain.handle("model:open-display-config", async () => {
    if (!modelDisplayFilePath || !fs.existsSync(modelDisplayFilePath)) {
      fs.writeFileSync(modelDisplayFilePath, JSON.stringify({ version: 1, models: {} }, null, 1), "utf8");
    }
    await shell.openPath(modelDisplayFilePath);
    return true;
  });
  ipcMain.handle("model:open-generated-scenes", async () => {
    if (scenesGeneratedFilePath) await shell.openPath(scenesGeneratedFilePath);
    return true;
  });
  ipcMain.handle("pet:show", () => {
    showPet();
    return rendererPayload();
  });
  ipcMain.handle("pet:hide", () => {
    hidePet();
    return rendererPayload();
  });
  // 桌宠改造：手动拖拽窗口（渲染进程把目标屏幕坐标传进来）
  ipcMain.handle("pet:move-window", (_event, pos) => {
    if (!pos) return false;
    return movePetWindow(Number(pos.x), Number(pos.y));
  });
  // 桌宠缩放：Ctrl+滚轮 / 管理页滑块 / 托盘 / 全局快捷键 共用（25%~200%，1% 粒度）
  ipcMain.handle("pet:set-scale", (_event, scale) => {
    const result = applyPetScale(Number(scale));
    return result;
  });
  ipcMain.handle("pet:get-scale", () => petScaleInfo());
  // 管理页「适应屏幕」按钮（与托盘菜单同一入口）
  ipcMain.handle("pet:fit-scale", () => fitPetScaleToScreen());
  // 全局快捷键：查询注册状态 / 重新注册（管理页保存后调用；托盘菜单同步刷新）
  ipcMain.handle("hotkeys:status", () => ({ status: hotkeyStatus, at: hotkeyStatusAt, enabled: hotkeySetting().enabled !== false }));
  ipcMain.handle("hotkeys:refresh", () => {
    registerGlobalHotkeys();
    refreshTrayMenu();
    broadcast();
    return { status: hotkeyStatus, at: hotkeyStatusAt, enabled: hotkeySetting().enabled !== false };
  });
  // 录制快捷键：调用后等用户按组合键，返回 accelerator 字符串（不直接保存）
  ipcMain.handle("hotkeys:record", () => beginHotkeyRecording(10000));
  // 聊天历史：按角色读写（user-data/chat-history.json）
  ipcMain.handle("chat:history-load", (_event, characterId) => {
    if (!chatHistory) return { ok: false, error: "chat history store not ready", entries: [] };
    return {
      ok: true,
      characterId: String(characterId || ""),
      entries: chatHistory.load(characterId),
      info: chatHistory.stats(),
      file: chatHistory.file
    };
  });
  ipcMain.handle("chat:history-append", (_event, payload) => {
    if (!chatHistory) return { ok: false, error: "chat history store not ready", entries: [] };
    const data = payload || {};
    const limit = (config.chat && config.chat.historyLimit) || 300;
    const entries = chatHistory.append(data.characterId, {
      role: data.role,
      content: data.content,
      ts: data.ts
    }, { limit });
    return { ok: true, entries, info: chatHistory.stats() };
  });
  ipcMain.handle("chat:history-clear", (_event, characterId) => {
    if (!chatHistory) return { ok: false, error: "chat history store not ready" };
    const info = chatHistory.clear(characterId);
    return { ok: true, info, entries: [] };
  });
  // 管理页「打开聊天记录面板」：复用宠物窗内的面板
  ipcMain.handle("chat:open-panel", () => toggleChatPanel());
  // 场景目录：切换场景 = 切换模型 + 播放代表场景（面板/AI/托盘共用）
  ipcMain.handle("scene:play-catalog", (_event, payload) => {
    return playCatalogScene(payload || {});
  });
  // 桌宠改造：截取宠物窗口自身画面（带透明通道）保存为 PNG，用于自检/留档
  ipcMain.handle("pet:capture-page", async (_event, filePath) => {
    if (!petWindow || petWindow.isDestroyed()) return { ok: false, error: "pet window not ready" };
    const target = path.resolve(String(filePath || path.join(app.getPath("userData"), "capture.png")));
    try {
      const image = await petWindow.webContents.capturePage();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      return { ok: true, path: target, size: image.getSize() };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });
  // Tavern IPC
  ipcMain.handle("tavern:chat", async (_event, messages) => {
    if (_tavernAbortController) _tavernAbortController.abort();
    _tavernAbortController = new AbortController();
    const signal = _tavernAbortController.signal;
    try {
      const tavern = config.tavern || {};
      const apiKey = tavern.textApiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
      const baseUrl = String(tavern.textBaseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
      if (!apiKey) throw new Error("聊天模型 API Key 未配置");
      // 角色卡：优先使用当前模型所属角色的提示词；没有匹配角色时回退通用兜底角色卡（tavern.rolePrompt）
      const activeCharacter = characterForModel(characterRegistry, selectedModel());
      const rolePrompt = activeCharacter && activeCharacter.prompt
        ? activeCharacter.prompt
        : String(tavern.rolePrompt || "");
      tavernLog("chat:start", {
        count: (messages || []).length,
        modelId: config.selectedModelId || "",
        characterId: activeCharacter ? activeCharacter.id : "",
        characterName: activeCharacter ? activeCharacter.name : "",
        promptSource: activeCharacter && activeCharacter.prompt ? activeCharacter.promptSource : "fallback"
      });
      // 场景协议 + 能力简报：场景说明仅在“AI 自动切换场景”开启时注入；
      // AI 缩放开关独立（默认关闭）：开启时也注入 caps.brief（其中含 set_scale 说明）
      const sceneAiEnabled = config.sceneAutoEnabled !== false && Boolean(scenesConfig);
      // 工具 schema 来自渲染进程上报的当前模型能力（模型无关：换模型后 schema 自动变化）
      const capsFresh = Boolean(lastCapabilities && lastCapabilities.model_id === (config.selectedModelId || ""));
      const caps = capsFresh ? lastCapabilities : null;
      // 刚切完模型、新模型还在加载时 caps 会对不上：只保留“换模型/查模型”工具，
      // 否则用户紧接着说“换回去”会因为没有工具而失败。
      const staleSwitchTools = !capsFresh && lastCapabilities && Array.isArray(lastCapabilities.tools)
        ? lastCapabilities.tools.filter((tool) => tool && tool.function && ["switch_model", "list_models"].includes(tool.function.name))
        : [];
      const baseScenePrompt = sceneAiEnabled
        ? buildSystemPrompt(rolePrompt, scenesConfig, config.selectedModelId)
        : rolePrompt;
      // 场景目录（63 个模型 = 可切换场景）：描述 + whenToUse + NSFW 限制，让 AI 能按语义选场景
      const catalogPrompt = sceneAiEnabled
        ? buildCatalogPrompt(sceneCatalog, { currentModelId: config.selectedModelId || "", sfw: currentSfw() })
        : "";
      const promptParts = [baseScenePrompt];
      if (sceneAiEnabled && catalogPrompt) promptParts.push(catalogPrompt);
      if (caps && caps.brief) promptParts.push(caps.brief);
      else if (staleSwitchTools.length) promptParts.push("（当前模型刚切换、正在加载；仍可用 switch_model / list_models 切换模型。）");
      const systemPrompt = promptParts.filter(Boolean).join("\n\n");
      // 工具由渲染进程按「场景开关 / 缩放开关」过滤：两者都关时为空数组 → 不开启 function calling
      const activeTools = caps && Array.isArray(caps.tools) ? caps.tools : staleSwitchTools;
      let useTools = Boolean(activeTools.length && !toolsUnsupported);
      const tools = useTools ? activeTools : null;
      const conversation = [{ role: "system", content: systemPrompt }].concat(messages || []);
      const toolResults = [];
      let finalMessage = null;
      const requestBody = (withTools) => JSON.stringify({
        model: tavern.textModel || "deepseek-chat",
        messages: conversation,
        temperature: Number(tavern.textTemperature || 0.8),
        max_tokens: Number(tavern.textMaxTokens || 160),
        thinking: { type: "disabled" },
        stream: false,
        ...(withTools && tools ? { tools, tool_choice: "auto" } : {})
      });
      const callApi = async (withTools) => {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
          body: requestBody(withTools),
          signal
        });
        return resp;
      };
      for (let round = 0; round < 4 && !finalMessage; round += 1) {
        let resp = await callApi(useTools);
        if (!resp.ok) {
          const status = resp.status;
          // 接口不支持 function calling：自动去掉 tools 重试一次（并记住，避免每次请求都报错）
          if (useTools && round === 0 && [400, 404, 422].includes(status)) {
            toolsUnsupported = true;
            useTools = false;
            tavernLog("chat:tools_unsupported", { status });
            resp = await callApi(false);
            if (!resp.ok) throw new Error("Chat API " + resp.status);
          } else {
            throw new Error("Chat API " + status);
          }
        }
        const data = await resp.json();
        const message = data.choices && data.choices[0] && data.choices[0].message;
        if (!message) throw new Error("Chat API 返回为空");
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (useTools && calls.length && round < 3) {
          // 执行工具：渲染进程真正切换动作/场景/换装，结果以 role:"tool" 回传模型
          conversation.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
          for (let ci = 0; ci < calls.length; ci += 1) {
            const call = calls[ci];
            const name = (call.function && call.function.name) || call.name || "";
            let args = {};
            try {
              args = JSON.parse((call.function && call.function.arguments) || "{}");
            } catch (e) {
              args = {};
            }
            const result = await petRunTool(name, args);
            toolResults.push({ name, args, result });
            conversation.push({
              role: "tool",
              tool_call_id: call.id || `call_${round}_${ci}`,
              content: JSON.stringify(result)
            });
          }
          tavernLog("chat:tool_round", { round, names: toolResults.map((item) => item.name) });
          continue;
        }
        if (useTools && calls.length && round >= 3) {
          // 超过最大工具轮次：不再执行，要求模型直接给最终文本
          conversation.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
          conversation.push({ role: "user", content: "（工具轮次已达上限，请直接用一两句话回复，不要再调用工具。）" });
          const finalResp = await callApi(false);
          if (!finalResp.ok) throw new Error("Chat API " + finalResp.status);
          const finalData = await finalResp.json();
          finalMessage = finalData.choices && finalData.choices[0] && finalData.choices[0].message;
          break;
        }
        finalMessage = message;
      }
      if (!finalMessage) throw new Error("Chat API 未返回最终回复");
      // 最终文本：剥掉场景标签再显示/朗读（工具调用标记不会出现在文本里）
      const rawContent = finalMessage.content || "";
      const parsed = parseSceneTags(rawContent);
      const reply = spokenTextOnly(parsed.text);
      tavernLog("chat:ok", {
        replyPreview: reply.slice(0, 40),
        scene: parsed.sceneIds[0] || null,
        tools: toolResults.map((item) => item.name),
        toolsEnabled: Boolean(useTools),
        toolsUnsupported
      });
      return {
        ok: true,
        reply,
        scene: parsed.sceneIds[0] || null,
        scenes: parsed.sceneIds,
        toolsUsed: toolResults,
        toolsEnabled: Boolean(useTools),
        toolsUnsupported
      };
    } catch (e) {
      tavernLog("chat:error", { name: e.name, message: e.message });
      if (e.name === "AbortError") return { ok: false, error: "aborted" };
      return { ok: false, error: e.message };
    } finally {
      _tavernAbortController = null;
    }
  });

  ipcMain.handle("tavern:tts", async (_event, text) => {
    const outFile = path.join(tavernChatPath(), "reply_" + Date.now() + ".mp3");
    try {
      const tavern = config.tavern || {};
      const token = tavern.ttsToken || process.env.VOLCENGINE_TOKEN || "";
      if (!token) throw new Error("火山 TTS Token 未配置");
      tavernLog("tts:start", { outFile, textPreview: String(text || "").slice(0, 40) });
      const payload = {
        app: {
          appid: tavern.ttsAppId || "3931757810",
          token: "access_token",
          cluster: tavern.ttsCluster || "volcano_tts"
        },
        user: { uid: "daidai_live2d_pet" },
        audio: {
          voice_type: tavern.voice || "zh_female_tianmeitaozi_uranus_bigtts",
          encoding: "mp3",
          speed_ratio: Number(tavern.ttsSpeed || 1),
          volume_ratio: 1.0
        },
        request: {
          reqid: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
          text: String(text || ""),
          operation: "query"
        }
      };
      const resp = await fetch(VOLC_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer;${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) throw new Error(`Volc TTS ${resp.status}`);
      const data = await resp.json();
      if (data.code !== 3000 || !data.data) {
        throw new Error(data.message || `Volc TTS code ${data.code}`);
      }
      fs.writeFileSync(outFile, Buffer.from(data.data, "base64"));
      tavernLog("tts:ok", { outFile, bytes: fs.statSync(outFile).size });
      return { ok: true, path: outFile, url: pathToFileURL(outFile).href };
    } catch (e) {
      tavernLog("tts:error", { error: String(e.message || e).slice(0, 300) });
      const tokenConfigured = Boolean((config.tavern && config.tavern.ttsToken) || process.env.VOLCENGINE_TOKEN);
      return {
        ok: false,
        error: String(e.message || e).slice(0, 300),
        // configured=false 表示用户根本没填 Token（文本模式照常工作，不必报错）
        configured: tokenConfigured,
        code: tokenConfigured ? "tts_failed" : "tts_not_configured"
      };
    }
  });

  ipcMain.handle("tavern:cleanup", async () => {
    try {
      const dir = tavernChatPath();
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const f of files) {
        if (f.endsWith(".mp3") && now - fs.statSync(path.join(dir, f)).mtimeMs > 3600000) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch (e) {}
    return true;
  });

  ipcMain.handle("tavern:focus-window", () => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.focus();
    }
    return true;
  });

  ipcMain.handle("tavern:abort", () => {
    if (_tavernAbortController) {
      _tavernAbortController.abort();
      _tavernAbortController = null;
    }
    return true;
  });

  // 角色卡：保存/恢复某个角色的提示词。只写 user-data/characters.json 并广播，
  // 不触发聊天/TTS 等任何外部 API 请求。
  ipcMain.handle("characters:set-prompt", (_event, payload) => {
    const characterId = payload && payload.id ? String(payload.id) : "";
    const prompt = payload && payload.reset === true ? "" : (payload && typeof payload.prompt === "string" ? payload.prompt : "");
    const result = saveCharacterPrompt({
      userDataDir: app.getPath("userData"),
      characterId,
      prompt
    });
    if (!result.ok) return { ok: false, error: result.error };
    loadCharactersForApp();
    broadcast();
    return {
      ok: true,
      cleared: Boolean(result.cleared),
      characters: buildCharactersPayload(characterRegistry, selectedModel()),
      activeCharacter: activeCharacterInfo()
    };
  });
  // 当前生效角色卡（用于 UI 自检/排障，不联网）
  ipcMain.handle("characters:get-active", () => activeCharacterInfo());

}


// 数据目录：DAIDAI_DATA_DIR 覆盖，否则便携模式放 exe 同级，开发模式放项目目录
var userDataPath;
if (process.env.DAIDAI_DATA_DIR) {
  userDataPath = path.resolve(process.env.DAIDAI_DATA_DIR);
} else if (app.isPackaged) {
  userDataPath = path.join(path.dirname(app.getPath('exe')), 'user-data');
} else {
  userDataPath = path.join(app.getAppPath(), 'user-data');
}
app.setPath('userData', userDataPath);
app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  // 修正 models.json 中指向不存在目录的旧路径
  const fixRegistryFile = path.join(app.getPath("userData"), 'models.json');
  if (fs.existsSync(fixRegistryFile)) {
    try {
      const reg = JSON.parse(fs.readFileSync(fixRegistryFile, 'utf8'));
      const fixModelsDir = path.join(app.getPath("userData"), 'models');
      let fixed = false;
      for (const m of reg.models) {
        if (m.directory && !fs.existsSync(m.directory) && m.id) {
          const newDir = path.join(fixModelsDir, m.id);
          if (fs.existsSync(newDir)) {
            m.directory = newDir;
            const entries = fs.readdirSync(newDir);
            const modelFile = entries.find(f => f.endsWith('.model.json') || f.endsWith('.model3.json'));
            if (modelFile) m.modelPath = path.join(newDir, modelFile);
            fixed = true;
          }
        }
      }
      if (fixed) {
        fs.writeFileSync(fixRegistryFile, JSON.stringify(reg, null, 2), 'utf8');
        console.log('[main] fixed stale paths in models.json');
      }
    } catch (e) {
      console.error('[main] models.json path fix failed:', e.message);
    }
  }

  configStore = createConfigStore(app.getPath("userData"));
  config = configStore.load();
  chatHistory = createChatHistoryStore(app.getPath("userData"));
  const librarySettings = modelLibrarySettings();
  modelRegistry = createModelRegistry({
    userDataDir: app.getPath("userData"),
    bundledModelsDir: path.join(app.getAppPath(), "assets", "models"),
    libraryRoots: librarySettings.roots,
    excludedRoots: librarySettings.excluded
  });
  // 启动时扫描模型库并注册到 models.json（未配置模型库时为空，可手动导入）
  // 可用 DAIDAI_SKIP_LIBRARY_SCAN=1 跳过（快速启动/离线调试）
  if (process.env.DAIDAI_SKIP_LIBRARY_SCAN !== "1") {
    try {
      const scanStarted = Date.now();
      const info = modelRegistry.rescanLibrary();
      console.log("[main] model library scan:", info.stats.total, "models in", Date.now() - scanStarted, "ms",
        "generatedScenes=", info.generatedScenesFile);
      if (info.issues && info.issues.length) console.warn("[main] model library issues:", info.issues.length);
    } catch (error) {
      console.error("[main] model library scan failed:", (error && error.message) || error);
    }
  }
  // 场景配置：app/config/scenes.json（可编辑）+ user-data/scenes.generated.json（自动生成）
  scenesFilePath = path.join(app.getAppPath(), "config", "scenes.json");
  loadAllScenes();
  // 场景目录（63 模型语义）：加载 + 启动辅助模型保底（lastModel 是剖面模型时回退立绘）
  loadCatalogForApp();
  // 角色注册表：角色 → 模型映射 + 每个角色的角色卡提示词
  loadCharactersForApp();
  ensurePetScaleState();
  const startupGuard = guardStartupModel();
  if (startupGuard.changed) {
    console.log("[main] startup model guard:", startupGuard.from, "->", startupGuard.to, "(", startupGuard.reason, ")");
  }

  // 首次启动：将预制模型复制到 userData + 注册，避免中文路径 file:// 加载问题
  const fsSync = fs;
  const modelsDir = path.join(app.getPath("userData"), "models");
  const registryFile = path.join(app.getPath("userData"), "models.json");
  const existingRegistry = (function() { try { return JSON.parse(fsSync.readFileSync(registryFile, "utf8")); } catch(e) { return { models: [] }; } })();
  const existingIds = new Set(existingRegistry.models.map(function(m){ return m.id }));

  const bundledModels = modelRegistry.list().filter(function(m){ return m.source === "bundled" });
  let anyImported = false;

  for (var bi = 0; bi < bundledModels.length; bi++) {
    var bm = bundledModels[bi];
    var dstDir = path.join(modelsDir, bm.name);
    // 跳过已导入的
    if (existingIds.has(bm.name)) continue;
    try {
      fsSync.cpSync(bm.directory, dstDir, { recursive: true, force: true });
      var modelFile = (function() {
        var entries = fsSync.readdirSync(dstDir, { withFileTypes: true });
        for (var ei = 0; ei < entries.length; ei++) {
          if (entries[ei].isFile() && (entries[ei].name.endsWith(".model.json") || entries[ei].name.endsWith(".model3.json"))) {
            return path.join(dstDir, entries[ei].name);
          }
        }
        return null;
      })();
      if (modelFile) {
        existingRegistry.models.push({
          id: bm.name,
          name: bm.name,
          source: "bundled",
          kind: bm.kind,
          directory: dstDir,
          modelPath: modelFile,
          importedAt: new Date().toISOString()
        });
        existingIds.add(bm.name);
        anyImported = true;
      }
    } catch(e) {
      console.error("[main] import bundled model failed:", bm.name, e.message);
    }
  }

  if (anyImported) {
    fsSync.writeFileSync(registryFile, JSON.stringify(existingRegistry, null, 2), "utf8");
  }

  // 若无有效选中的模型，自动选第一个可用
  const allModels = modelRegistry.list();
  if (allModels.length && (!config.selectedModelId || !modelRegistry.get(config.selectedModelId))) {
    config = configStore.save({ selectedModelId: allModels[0].id });
  }

  statusPoller = createStatusPoller({
    getUrl: () => config.statusPollUrl,
    onUpdate: broadcast
  });
  statusBridge = createStatusBridge({
    onChange: () => {
      if (statusPoller) statusPoller.tickNow();
    }
  });
  codexMonitor = createCodexSessionMonitor({
    onEvent: (event) => {
      if (!statusBridge) return;
      statusBridge.updateState((event.data && event.data.agent) || "codex", event.event, event.data);
    }
  });

  registerIpc();
  createPetWindow();
  createManagerWindow();
  createScenesWindow();
  registerGlobalHotkeys();
  createTray();
  startAlwaysOnTopGuard();
  startCursorForwarding();
  statusBridge.start();
  codexMonitor.start();
  statusPoller.start();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createPetWindow();
    createManagerWindow();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  // 释放全局快捷键（否则退出后组合键仍被占用，直到进程结束）
  try { globalShortcut.unregisterAll(); } catch (e) {}
  if (statusPoller) statusPoller.stop();
  if (codexMonitor) codexMonitor.stop();
  if (statusBridge) statusBridge.stop();
  if (cursorTimer) clearInterval(cursorTimer);
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  if (dragEndTimer) clearTimeout(dragEndTimer);
  if (topTimer) clearInterval(topTimer);
});

// 官方推荐在 will-quit 释放快捷键（before-quit 里已经放一次，双保险；
// 快捷键录制期间会被 setSuspended 挂起，异常退出也要保证恢复）。
app.on("will-quit", () => {
  try { globalShortcut.setSuspended(false); } catch (e) {}
  try { globalShortcut.unregisterAll(); } catch (e) {}
});
