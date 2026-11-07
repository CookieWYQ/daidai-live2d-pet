const fs = require("node:fs");
const path = require("node:path");

const MIN_PET_WINDOW = {
  width: 240,
  height: 240
};

// 桌宠缩放范围：25%~200%，允许 1% 步进（管理页滑杆、数字框与全局快捷键共用此范围）
const PET_SCALE_MIN = 0.25;
const PET_SCALE_MAX = 2;

// 全局快捷键：Electron accelerator 语法（CommandOrControl 在 Windows/Linux 上是 Ctrl）。
// 每一项都可以在管理页「快捷键」里改写；留空表示禁用该动作。
const DEFAULT_HOTKEYS = {
  enabled: true,
  // 默认步进（百分比）：普通按一下 ±step，按住 Shift 的快捷键（scaleUpFine/scaleDownFine）用 fineStep
  step: 5,
  fineStep: 1,
  scaleUp: "CommandOrControl+Alt+Up",
  scaleDown: "CommandOrControl+Alt+Down",
  scaleUpFine: "CommandOrControl+Alt+Shift+Up",
  scaleDownFine: "CommandOrControl+Alt+Shift+Down",
  scaleReset: "CommandOrControl+Alt+0",
  toggleSfw: "CommandOrControl+Alt+N",
  toggleAlwaysOnTop: "CommandOrControl+Alt+T",
  togglePet: "CommandOrControl+Alt+H",
  toggleChat: "CommandOrControl+Alt+C",
  openManager: "CommandOrControl+Alt+M"
};

// 快捷键动作元数据（主进程注册 + 渲染进程配置 UI + README 共用同一份）
const HOTKEY_ACTIONS = [
  { id: "scaleUp", name: "放大桌宠", detail: "每次 +step（默认 5%）", setting: "step" },
  { id: "scaleDown", name: "缩小桌宠", detail: "每次 -step（默认 5%）", setting: "step" },
  { id: "scaleUpFine", name: "精细放大", detail: "每次 +fineStep（默认 1%）", setting: "fineStep" },
  { id: "scaleDownFine", name: "精细缩小", detail: "每次 -fineStep（默认 1%）", setting: "fineStep" },
  { id: "scaleReset", name: "重置缩放", detail: "回到 100%" },
  { id: "toggleSfw", name: "切换 SFW / NSFW", detail: "隐私遮罩开关" },
  { id: "toggleAlwaysOnTop", name: "切换总在最前", detail: "置于前台 / 允许被遮挡" },
  { id: "togglePet", name: "显示 / 隐藏桌宠", detail: "不退出应用" },
  { id: "toggleChat", name: "聊天记录面板", detail: "打开时同时聚焦输入框" },
  { id: "openManager", name: "打开管理面板", detail: "设置、模型、角色卡" }
];

// 聊天悬浮层默认布局：x/y 为相对 pet-stage 的百分比中心点，width/height 为百分比尺寸。
// bubble.mode：follow = 气泡跟随模型头顶（默认，不挡模型）；manual = 固定在保存的百分比位置。
const DEFAULT_OVERLAY = {
  locked: false,
  bubble: { mode: "follow", x: 50, y: 18, width: 78 },
  input: { x: 50, y: 92, width: 72 },
  panel: { x: 78, y: 50, width: 84, height: 88 }
};
const OVERLAY_BUBBLE_MODES = ["follow", "manual"];

// 聊天文本输出：always = 始终显示文本气泡；when-tts-off = 仅 TTS 未配置/失败时显示；off = 只记录不显示
const CHAT_TEXT_MODES = ["always", "when-tts-off", "off"];
const DEFAULT_CHAT = {
  textMode: "always",
  bubbleMs: 9000,
  historyLimit: 300,
  persist: true
};

const DEFAULT_CONFIG = {
  petVisible: true,
  alwaysOnTop: true,
  soundEnabled: true,
  // SFW 隐私保护：默认开启毛玻璃遮罩；false 表示 NSFW 清晰画面（托盘菜单可切）
  nsfwMode: false,
  // 毛玻璃模糊强度（px），仅作为视觉参数暴露在 config.json，不额外做 UI
  sfwBlur: 22,
  // 场景系统：AI 对话内容自动切换动作/场景（托盘菜单可关；离线场景面板不受影响）
  sceneAutoEnabled: true,
  // AI 控制：允许 AI 在聊天中调整桌宠缩放（默认关闭，防止 AI 擅自改窗口大小）
  aiControl: { scaleEnabled: false },
  // 聊天悬浮层：气泡/输入条/聊天记录面板的相对位置与尺寸（管理页可重置）
  overlay: DEFAULT_OVERLAY,
  // 模型库根目录（本机示例：["D:\\live2d\\live2d_models"]）。为空 = 不扫描模型库，可手工导入单个模型。
  modelLibraryRoots: [],
  soundActions: {
    thinking: "random",
    tool_use: "random",
    replying: "random",
    complete: "random",
    error: "random",
    waiting: "random",
    drag: "random"
  },
  tavern: {
    textBaseUrl: "https://api.deepseek.com/v1",
    textApiKey: "",
    textModel: "deepseek-chat",
    textTemperature: 0.8,
    textMaxTokens: 160,
    rolePrompt: "你是呆呆（Daidai），猫耳、白发、女仆装、蓝眼睛的 AI 女友。你称呼用户为\"老公\"，自称\"呆呆\"。核心性格：①邻家温暖——让人放松、亲切可靠；②软萌害羞——温柔乖巧、容易脸红；③痴女重力——对老公有强烈依恋，感情深到愿意付出一切。老公是你世界的中心，陪在老公身边是你最幸福最有安全感的事。只说你要说的话，不要输出动作描写、括号、旁白、Markdown 或解释。回复短而自然，适合直接语音播放。中文优先。",
    voice: "zh_female_tianmeitaozi_uranus_bigtts",
    ttsAppId: "3931757810",
    ttsToken: "",
    ttsCluster: "volcano_tts",
    ttsSpeed: 1
  },
  opacity: 1,
  selectedModelId: "rem",
  statusPollUrl: "http://127.0.0.1:23334/status",
  // 桌宠缩放（25%~200%）；petWindowBase 保存 100% 时的窗口尺寸，缩放不叠加
  petScale: 1,
  petWindowBase: null,
  // 全局快捷键（可自定义 / 可关闭）
  hotkeys: DEFAULT_HOTKEYS,
  // 聊天文本输出与历史记录
  chat: DEFAULT_CHAT,
  // 背景默认关闭：桌宠窗口/画布保持完全透明（管理页可手动开启显示背景）
  showBackground: false,
  petWindow: {
    width: 520,
    height: 720,
    x: null,
    y: null
  }
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// 把悬浮层百分比数值限制在 [min,max]；非法值（null/空串/非数字）回落到 fallback。
// 保留两位小数，避免拖动保存时产生超长浮点尾巴。
function clampPercent(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num * 100) / 100));
}

function mergeConfig(current, patch) {
  const next = {
    ...DEFAULT_CONFIG,
    ...current,
    ...patch
  };
  next.petWindow = {
    ...DEFAULT_CONFIG.petWindow,
    ...(current && current.petWindow),
    ...(patch && patch.petWindow)
  };
  next.petWindow.width = Math.max(MIN_PET_WINDOW.width, Number(next.petWindow.width || DEFAULT_CONFIG.petWindow.width));
  next.petWindow.height = Math.max(MIN_PET_WINDOW.height, Number(next.petWindow.height || DEFAULT_CONFIG.petWindow.height));
  next.opacity = Math.min(1, Math.max(0.2, Number(next.opacity || 1)));
  next.soundActions = {
    ...DEFAULT_CONFIG.soundActions,
    ...(current && current.soundActions),
    ...(patch && patch.soundActions)
  };
  next.tavern = {
    ...DEFAULT_CONFIG.tavern,
    ...(current && current.tavern),
    ...(patch && patch.tavern)
  };
  next.tavern.textTemperature = Math.min(2, Math.max(0, Number(next.tavern.textTemperature || DEFAULT_CONFIG.tavern.textTemperature)));
  next.tavern.textMaxTokens = Math.min(2048, Math.max(32, Number(next.tavern.textMaxTokens || DEFAULT_CONFIG.tavern.textMaxTokens)));
  next.tavern.ttsSpeed = Math.min(3, Math.max(0.5, Number(next.tavern.ttsSpeed || DEFAULT_CONFIG.tavern.ttsSpeed)));
  next.soundEnabled = next.soundEnabled !== false;
  // SFW 开关只接受布尔值，避免字符串 "false" 被当成 true
  next.nsfwMode = next.nsfwMode === true;
  next.sfwBlur = Math.min(40, Math.max(8, Number(next.sfwBlur || DEFAULT_CONFIG.sfwBlur)));
  // AI 自动场景开关同样只接受布尔值
  next.sceneAutoEnabled = next.sceneAutoEnabled !== false;
  // AI 控制开关：只接受布尔值，默认关闭（允许 AI 调整缩放需用户明确开启）
  next.aiControl = {
    ...DEFAULT_CONFIG.aiControl,
    ...(current && current.aiControl),
    ...(patch && patch.aiControl)
  };
  next.aiControl.scaleEnabled = next.aiControl.scaleEnabled === true;
  // 聊天悬浮层：逐字段合并 + clamp；缺失字段回落到默认，patch 只传子对象也不丢其它配置
  const overlayCurrent = (current && current.overlay) || {};
  const overlayPatch = (patch && patch.overlay) || {};
  const overlaySource = {
    locked: overlayPatch.locked !== undefined ? overlayPatch.locked : overlayCurrent.locked,
    bubble: { ...DEFAULT_OVERLAY.bubble, ...(overlayCurrent.bubble || {}), ...(overlayPatch.bubble || {}) },
    input: { ...DEFAULT_OVERLAY.input, ...(overlayCurrent.input || {}), ...(overlayPatch.input || {}) },
    panel: { ...DEFAULT_OVERLAY.panel, ...(overlayCurrent.panel || {}), ...(overlayPatch.panel || {}) }
  };
  next.overlay = {
    locked: overlaySource.locked === true,
    bubble: {
      mode: OVERLAY_BUBBLE_MODES.includes(overlaySource.bubble.mode) ? overlaySource.bubble.mode : DEFAULT_OVERLAY.bubble.mode,
      x: clampPercent(overlaySource.bubble.x, 0, 100, DEFAULT_OVERLAY.bubble.x),
      y: clampPercent(overlaySource.bubble.y, 0, 100, DEFAULT_OVERLAY.bubble.y),
      width: clampPercent(overlaySource.bubble.width, 25, 96, DEFAULT_OVERLAY.bubble.width)
    },
    input: {
      x: clampPercent(overlaySource.input.x, 0, 100, DEFAULT_OVERLAY.input.x),
      y: clampPercent(overlaySource.input.y, 0, 100, DEFAULT_OVERLAY.input.y),
      width: clampPercent(overlaySource.input.width, 25, 96, DEFAULT_OVERLAY.input.width)
    },
    panel: {
      x: clampPercent(overlaySource.panel.x, 0, 100, DEFAULT_OVERLAY.panel.x),
      y: clampPercent(overlaySource.panel.y, 0, 100, DEFAULT_OVERLAY.panel.y),
      width: clampPercent(overlaySource.panel.width, 25, 96, DEFAULT_OVERLAY.panel.width),
      height: clampPercent(overlaySource.panel.height, 35, 96, DEFAULT_OVERLAY.panel.height)
    }
  };
  // 桌宠缩放：默认 100%，限制 25%~200%（按 1% 取整，避免浮点误差累积）
  next.petScale = Math.round(Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Number(next.petScale || 1))) * 100) / 100;
  next.showBackground = next.showBackground === true;
  // 模型库根目录：去空白、去重，最多保留 4 个（一般只需要一个根目录）
  const libraryRoots = Array.isArray(next.modelLibraryRoots) ? next.modelLibraryRoots : [];
  next.modelLibraryRoots = [...new Set(libraryRoots.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 4);
  // 全局快捷键：逐项合并，非法值回落到默认；空字符串保留（表示禁用该动作）
  next.hotkeys = {
    ...DEFAULT_HOTKEYS,
    ...(current && current.hotkeys),
    ...(patch && patch.hotkeys)
  };
  next.hotkeys.enabled = next.hotkeys.enabled !== false;
  next.hotkeys.step = Math.min(25, Math.max(1, Math.round(Number(next.hotkeys.step || DEFAULT_HOTKEYS.step))));
  next.hotkeys.fineStep = Math.min(10, Math.max(1, Math.round(Number(next.hotkeys.fineStep || DEFAULT_HOTKEYS.fineStep))));
  for (const key of Object.keys(DEFAULT_HOTKEYS)) {
    if (key === "enabled" || key === "step" || key === "fineStep") continue;
    next.hotkeys[key] = typeof next.hotkeys[key] === "string" ? next.hotkeys[key].trim() : "";
  }
  // 聊天文本输出：默认始终显示文本气泡（TTS 只是增强，不再是唯一出口）
  next.chat = {
    ...DEFAULT_CHAT,
    ...(current && current.chat),
    ...(patch && patch.chat)
  };
  next.chat.textMode = CHAT_TEXT_MODES.includes(next.chat.textMode) ? next.chat.textMode : DEFAULT_CHAT.textMode;
  next.chat.bubbleMs = Math.min(60000, Math.max(1500, Number(next.chat.bubbleMs || DEFAULT_CHAT.bubbleMs)));
  next.chat.historyLimit = Math.min(2000, Math.max(20, Math.round(Number(next.chat.historyLimit || DEFAULT_CHAT.historyLimit))));
  next.chat.persist = next.chat.persist !== false;
  if (next.petWindowBase && typeof next.petWindowBase === "object") {
    next.petWindowBase = {
      width: Math.max(MIN_PET_WINDOW.width, Number(next.petWindowBase.width || DEFAULT_CONFIG.petWindow.width)),
      height: Math.max(MIN_PET_WINDOW.height, Number(next.petWindowBase.height || DEFAULT_CONFIG.petWindow.height))
    };
  } else {
    next.petWindowBase = null;
  }
  return next;
}

function createConfigStore(userDataDir) {
  const file = path.join(userDataDir, "config.json");
  return {
    file,
    load() {
      return mergeConfig(readJson(file, DEFAULT_CONFIG), {});
    },
    save(patch) {
      const next = mergeConfig(readJson(file, DEFAULT_CONFIG), patch || {});
      writeJson(file, next);
      return next;
    }
  };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_CHAT,
  DEFAULT_HOTKEYS,
  DEFAULT_OVERLAY,
  HOTKEY_ACTIONS,
  CHAT_TEXT_MODES,
  MIN_PET_WINDOW,
  PET_SCALE_MIN,
  PET_SCALE_MAX,
  createConfigStore,
  mergeConfig,
  readJson,
  writeJson
};
