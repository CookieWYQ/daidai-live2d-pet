(function () {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") || "pet";
  const api = window.daidaiPet;
  const root = document.getElementById("app");

  // 声音统一由本文件按模型 links.json/model_info 播放；关闭运行时内建播放，
  // 避免 Cubism2 模型出现“引擎自动播放 + 本文件播放”的双份声音。
  try {
    if (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.config) {
      window.PIXI.live2d.config.sound = false;
    }
  } catch (e) {}
  var RUNTIME_KINDS = { "cubism2": "Cubism 2", "cubism3+": "Cubism 3/4" };

  let appState = null;
  let live2dApp = null;
  let live2dModel = null;
  let loadedModelId = null;
  let live2dResizeHandler = null;
  let cursorFocusTimer = null;
  let dragReactionUntil = 0;
  let lastDragMotionAt = 0;
  let tavernHistory = [];
  let tavernBusy = false;
  // 当前聊天角色：切换模型导致角色变化时清空历史，避免旧角色上下文串戏
  let tavernCharacterId = "";
  let tavernAudioEl = null;
  let tavernAudioCtx = null;
  let tavernAnalyser = null;
  let tavernLipSyncTicker = null;
  let tavernLipSyncData = null;
  let tavernLipSyncApplyHandler = null;
  let tavernLipSyncModel = null;
  let tavernLastMouthValue = 0;
  // 聊天文本输出（TTS 可选）：气泡队列 + 历史记录面板
  let chatBubbles = [];
  let chatPanelOpen = false;
  let chatHistoryEntries = [];
  let chatTypeTimer = null;
  let chatScrollNearBottom = true;
  // 快捷键录制状态（管理页「录制」按钮）
  let hotkeyCaptureId = "";
  let randomBodyMotionTimer = null;
  // 自动化截图用：暂停随机身体动作（换装/位移会改变实际绘制内容包围盒，影响缩放测量稳定性）
  let randomBodyMotionPaused = false;
  let speakingBodyMotionTimer = null;
  let hoverGreetTimer = null;
  let lastHoverGreetAt = 0;
  let wasCursorInside = false;
  let suppressManagerRender = false;
  let pendingManagerState = null;
  // 管理页模型列表：搜索 / 格式筛选状态（重新渲染时保持）
  let managerModelQuery = "";
  let managerModelKind = "all";
  // 管理页角色卡：当前查看的角色 + 最近保存状态（重新渲染时保持）
  let managerCharacterId = "";
  let managerCharacterStatus = "";
  // 场景目录：主进程切换场景时先发 pet:catalog-scene，等模型加载完成后执行
  let pendingCatalogScene = null;
  // 聊天悬浮层：布局刷新节流、拖动会话、拖动后短暂抑制气泡 click（避免拖完误开聊天面板）
  let overlayLayoutTimer = null;
  let overlayLayoutForce = false;
  let overlayDrag = null;
  let overlaySuppressClickUntil = 0;
  // follow 锚点测量缓存：同一模型/窗口尺寸下复用像素包围盒，避免每次状态轮询都 readPixels
  let overlayArtCache = null;
  let managerSelectError = "";
  let statusMotionKind = "idle";
  let statusMotionTimer = null;
  // 桌宠改造：当前模型记录、模型自带的“动作↔原声”关联、拖拽/点击状态
  let currentModelRecord = null;
  let modelLinks = [];
  let lastCursorPayload = null;
  let dragSession = null;
  // SFW 毛玻璃：自动化测试可临时覆盖当前画面清晰/模糊，但不写入 config.json
  let debugNsfwOverride = null;
  // 场景/参数调试：按参数 id 或索引覆盖模型参数（每帧 beforeModelUpdate 应用，测试场景/换装能力用）
  let debugParamOverrides = null;
  let debugPartOverrides = null;
  // Cubism3/4 背景探测：临时隐藏单个部件（在 core.update 之后生效）
  let debugC4HiddenPart = null;
  // 逐像素背景探测：保存基准画面 + 临时隐藏的 drawable 索引
  let debugPixelBaseline = null;
  let debugC4HiddenDrawables = [];
  // 场景系统运行态（离线动作/场景 + AI 触发）
  var sceneRuntime = {
    config: null,        // 主进程下发的 scenes.json（已归一化）
    current: null,       // 当前场景快照
    paramState: {},      // 持久参数覆盖（换装状态：Param/Param30 等）
    partState: {},       // 持久部件透明度覆盖
    transition: null,    // 参数过渡动画 { keys, from, to, startedAt, durationMs }
    timer: null,
    lastFinished: null,
    cooldownUntil: 0,
    priorityCooldownUntil: 0,
    aiEnabled: true,
    modelId: null
  };
  var SCENE_CATEGORY_PRIORITY = { "换装": 3, "亲密": 3, "情绪": 2, "日常": 1, "其他": 1 };
  var _sceneMotionIndex = null;
  var _sceneToastTimer = null;
  // 全局错误捕获 - 显示在宠物窗上
  window.addEventListener("error", function(e) {
    try {
      if (api && api.reportRendererError) {
        api.reportRendererError({
          message: e.message || "",
          filename: e.filename || "",
          lineno: e.lineno || 0,
          colno: e.colno || 0
        });
      }
    } catch {}
    var el = document.getElementById("empty-pet");
    if (el) {
      el.style.display = "grid";
      el.querySelector("strong").textContent = `JS Error ${e.lineno || ""}:${e.colno || ""}`;
      el.querySelector("span").textContent = e.message || "未知错误";
    }
  });
  const lastReply = { codex: "", claude: "" };
  const holdUntil = { codex: 0, claude: 0 };
  const hideTimer = { codex: null, claude: null };
  const holdSignature = { codex: "", claude: "" };
  const dismissedSignature = { codex: "", claude: "" };

  function statusLabel(kind) {
    const labels = {
      thinking: "思考中",
      "running-tool": "运行中",
      "tool_use": "运行中",
      replying: "回复中",
      complete: "完成",
      completed: "完成",
      error: "出错",
      idle: "待机中"
    };
    return labels[kind] || kind || "待机中";
  }

  function dotKind(kind) {
    if (kind === "thinking") return "thinking";
    if (kind === "running-tool" || kind === "tool_use") return "working";
    if (kind === "replying") return "replying";
    if (kind === "complete" || kind === "completed") return "complete";
    if (kind === "error") return "error";
    return "idle";
  }

  function sourceName(source) {
    return source === "claude" ? "Claude Code" : "Codex";
  }

  function toolLabel(tool) {
    const labels = {
      read: "读取文件",
      write: "写入文件",
      edit: "编辑文件",
      search: "搜索中",
      fetch: "网络请求",
      execute: "执行命令",
      bash: "终端命令",
      shell: "终端命令",
      grep: "代码搜索",
      ls: "浏览目录",
      glob: "文件搜索",
      task: "子任务",
      memory: "记忆检索",
      skill: "技能调用",
      mcp: "MCP 工具"
    };
    return labels[tool] || tool || "";
  }

  function pickSource(status, source) {
    const sources = (status && status.sources) || [];
    return sources.find((item) => item.source === source) || null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function focusLive2d(x, y, instant) {
    if (!live2dModel) return;
    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);

    try {
      if (live2dModel.internalModel && live2dModel.internalModel.focusController) {
        live2dModel.internalModel.focusController.focus(x, y, Boolean(instant));
        return;
      }
    } catch {}

    try {
      if (typeof live2dModel.focus === "function" && live2dApp) {
        const sx = ((x + 1) / 2) * live2dApp.screen.width;
        const sy = ((1 - y) / 2) * live2dApp.screen.height;
        live2dModel.focus(sx, sy, Boolean(instant));
      }
    } catch {}
  }

  function focusCursorPoint(x, y, instant) {
    if (!live2dModel) return;

    try {
      if (typeof live2dModel.focus === "function") {
        live2dModel.focus(x, y, Boolean(instant));
        return;
      }
    } catch {}

    if (!live2dApp) return;
    const nx = (x / Math.max(1, live2dApp.screen.width)) * 2 - 1;
    const ny = -((y / Math.max(1, live2dApp.screen.height)) * 2 - 1);
    focusLive2d(nx, ny, instant);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function resetCursorFocus() {
    focusLive2d(0, 0, false);
  }

  // 桌宠改造：随机动作只挑“人物对话/待机/过渡”类动作（folder2 模型的 OP_/tFRM_/uFRG_ 是正常对话动作，
  // folder1 的 idle/Breath/move 是待机动作），避免 H 场景动作（cum/finish 等）在桌面上随机乱入。
  var SAFE_MOTION_RE = /(?:^|\/)(OP_|SJ_|tFRM_|uFRG_|vtaneG_|zED_|idle|breath|move|talk|hello|greet|stand)/i;

  function safeMotionIndices(group) {
    var defs = motionDefinitions();
    var entries = (defs && defs[group]) || [];
    var indices = [];
    for (var i = 0; i < entries.length; i++) {
      var file = entries[i] && (entries[i].file || entries[i].File);
      if (file && SAFE_MOTION_RE.test(String(file))) indices.push(i);
    }
    return indices;
  }

  // 桌宠改造：兼容“只有一个空字符串动作组”的 Cubism2 模型（folder2 的 Tyrano 模型就是这种结构）。
  // 模型没有指定动作组时（如 flick_head/tap_body），退回模型里第一个可用动作组随机播放。
  function playLive2dMotion(group, index, actionKind, options) {
    if (!live2dModel) return;
    var silent = options && options.silent;
    var defs = motionDefinitions();
    var targetGroup = group;
    var targetIndex = index || 0;
    if (targetGroup === undefined || targetGroup === null ||
        !Array.isArray(defs[targetGroup]) || !defs[targetGroup].length) {
      var groups = Object.keys(defs);
      if (!groups.length) return;
      targetGroup = groups[0];
      var safe = safeMotionIndices(targetGroup);
      var total = (defs[targetGroup] || []).length;
      targetIndex = safe.length
        ? safe[Math.floor(Math.random() * safe.length)]
        : Math.floor(Math.random() * total);
    }
    try {
      live2dModel.motion(targetGroup, targetIndex);
      if (!silent && loadedModelId && (actionKind === "tap" || actionKind === "flick_head" || actionKind === "drag")) {
        tryPlayModelSound(actionKind);
      }
    } catch {}
  }

  // 读取模型目录下的 links.json（动作↔原声映射），点击互动时用来播放模型自带声音。
  // 新增：主进程扫描时已把 63 个模型的动作↔原声关联写进注册表（含 file:// 声音地址），
  // 直接复用；没有扫描信息时才回退到 fetch links.json（兼容手工导入的模型）。
  function normalizeMotionKey(file) {
    return String(file || "")
      .replace(/\\/g, "/")
      .replace(/^.*\//, "")
      .replace(/\.(motion3\.json|mtn|json)$/i, "")
      .toLowerCase();
  }

  function isSoundEnabled() {
    return !(appState && appState.config && appState.config.soundEnabled === false);
  }

  function loadModelLinks(model) {
    var fromRegistry = Array.isArray(model && model.links) ? model.links : [];
    if (fromRegistry.length) {
      return Promise.resolve(fromRegistry
        .filter(function(link) { return link && link.motion && (link.sound || link.soundUrl); })
        .map(function(link) {
          return {
            motion: String(link.motion || ""),
            action: String(link.action || ""),
            sound: String(link.sound || ""),
            soundUrl: String(link.soundUrl || "")
          };
        }));
    }
    return new Promise(function(resolve) {
      try {
        var raw = String((model && (model.modelUrl || model.modelPath)) || "");
        if (!raw) return resolve([]);
        var dir = raw.replace(/[^/\\]*$/, "");
        var linksUrl = dir + "links.json";
        fetch(linksUrl).then(function(r) {
          if (!r.ok) return resolve([]);
          return r.json().then(function(data) {
            var links = (data && data.links) || [];
            resolve(links.filter(function(link) {
              return link && link.motion;
            }).map(function(link) {
              return {
                motion: String(link.motion || ""),
                action: String(link.action || ""),
                sound: String(link.sound || link.audio || ""),
                soundUrl: ""
              };
            }));
          });
        }).catch(function() { resolve([]); });
      } catch (e) {
        resolve([]);
      }
    });
  }

  function modelDirUrl() {
    var raw = String((currentModelRecord && (currentModelRecord.modelUrl || currentModelRecord.modelPath)) || "");
    return raw.replace(/[^/\\]*$/, "");
  }

  function encodeRelPath(rel) {
    return String(rel || "").replace(/\\/g, "/").split("/").map(function(seg) {
      return encodeURIComponent(seg);
    }).join("/");
  }

  // 播放 links.json / model_info 里关联的原声；支持 file:// 绝对地址与相对模型目录的路径
  function playLinkedSound(linkOrSound) {
    try {
      if (!isSoundEnabled()) return false;
      var url = "";
      if (linkOrSound && typeof linkOrSound === "object") {
        if (linkOrSound.soundUrl) url = linkOrSound.soundUrl;
        else if (linkOrSound.sound) url = modelDirUrl() + encodeRelPath(linkOrSound.sound);
      } else if (linkOrSound) {
        var raw = String(linkOrSound);
        url = /^(file|https?|data):/i.test(raw) ? raw : modelDirUrl() + encodeRelPath(raw);
      }
      if (!url) return false;
      var audio = new Audio(url);
      audio.volume = 0.75;
      // 自检钩子：记录最近一次原声，便于自动化验证声音链路
      window.__lastPetSoundUrl = url;
      window.__lastPetSoundPlaying = false;
      window.__lastPetSoundError = "";
      audio.addEventListener("playing", function() { window.__lastPetSoundPlaying = true; });
      audio.addEventListener("error", function() { window.__lastPetSoundError = url; });
      audio.play().catch(function() {});
      return true;
    } catch (e) {
      return false;
    }
  }

  // 按“动作名”查动作↔原声关联并播放（场景随机动作/动作组场景用）
  function playSoundForMotion(motionName) {
    if (!isSoundEnabled()) return false;
    var wanted = normalizeMotionKey(motionName);
    if (!wanted) return false;
    var links = modelLinks || [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (!link || (!link.soundUrl && !link.sound)) continue;
      if (normalizeMotionKey(link.motion) === wanted || normalizeMotionKey(link.action) === wanted) {
        return playLinkedSound(link);
      }
    }
    return false;
  }

  // 点一下桌宠：从 links.json 里挑一条“动作+原声”，播放动作并同步播放原声
  function triggerPetClickInteraction() {
    if (!live2dModel) return;
    window.__petClicks = (window.__petClicks || 0) + 1;
    var candidates = (modelLinks || []).filter(function(link) { return link && link.sound; });
    if (!candidates.length) {
      playLive2dMotion("tap_body", 0, "tap");
      return;
    }
    var link = candidates[Math.floor(Math.random() * candidates.length)];
    var defs = motionDefinitions();
    var groups = Object.keys(defs);
    var played = false;
    var targetMotion = String(link.motion || "").replace(/\\/g, "/").toLowerCase();
    for (var gi = 0; gi < groups.length && !played; gi++) {
      var entries = defs[groups[gi]] || [];
      for (var i = 0; i < entries.length; i++) {
        var file = entries[i] && (entries[i].file || entries[i].File);
        if (file && String(file).replace(/\\/g, "/").toLowerCase() === targetMotion) {
          try {
            live2dModel.motion(groups[gi], i);
            played = true;
          } catch (e) {}
          break;
        }
      }
    }
    if (!played) playLive2dMotion("tap_body", 0, "tap", { silent: true });
    playLinkedSound(link);
  }

  function motionDefinitions() {
    try {
      var manager = live2dModel && live2dModel.internalModel && live2dModel.internalModel.motionManager;
      return manager && manager.definitions ? manager.definitions : {};
    } catch(e) {
      return {};
    }
  }

  // 场景系统 r1：参数/部件覆盖，绑定到模型 beforeModelUpdate（与口型同步同一机制）
  var _overrideHandlerBound = false;
  function resolveParamIndex(core, key) {
    try {
      if (typeof key === "number") return key;
      var idx = -1;
      try { idx = core.getParamIndex(String(key)); } catch (e) {}
      if (idx === undefined || idx === null || idx < 0) {
        var m = String(key).match(/^Param(\d*)$/i);
        if (m) {
          var n = m[1] === "" ? 0 : Number(m[1]);
          idx = core.getParamIndex("Param" + (m[1] === "" ? "" : n));
        }
      }
      return idx;
    } catch (e) { return -1; }
  }
  function resolvePartIndex(core, key) {
    try {
      if (typeof key === "number") return key;
      var text = String(key);
      if (/^\d+$/.test(text)) return Number(text);
      if (typeof core.getPartsDataIndex === "function") {
        var c2Index = core.getPartsDataIndex(text);
        if (typeof c2Index === "number" && c2Index >= 0) return c2Index;
      }
      if (typeof core.getPartIndex === "function") {
        var c4Index = core.getPartIndex(text);
        if (typeof c4Index === "number" && c4Index >= 0) return c4Index;
      }
      return -1;
    } catch (e) { return -1; }
  }

  // 部件透明度：同时兼容 Cubism2（索引 + setPartsOpacity）与 Cubism3/4（id/索引 + setPartOpacityByIndex）
  function setPartOpacityKey(core, key, opacity) {
    try {
      if (!core) return false;
      var index = -1;
      if (typeof key === "number") index = key;
      else if (/^\d+$/.test(String(key))) index = Number(key);
      if (index < 0) {
        try { if (typeof core.getPartsDataIndex === "function") index = core.getPartsDataIndex(String(key)); } catch (e) {}
      }
      if (index < 0) {
        try { if (typeof core.getPartIndex === "function") index = core.getPartIndex(String(key)); } catch (e) {}
      }
      if (index >= 0) {
        if (typeof core.setPartsOpacity === "function") { core.setPartsOpacity(index, opacity); return true; }
        if (typeof core.setPartOpacityByIndex === "function") { core.setPartOpacityByIndex(index, opacity); return true; }
      }
      if (typeof core.setPartOpacityById === "function") { core.setPartOpacityById(String(key), opacity); return true; }
    } catch (e) {}
    return false;
  }

  // 当前模型需要隐藏的部件（场景配置 hiddenParts + model-display.json 探测结果 + 旧 config.hiddenParts）
  var hiddenPartState = [];
  // Cubism3/4 若背景不是独立部件（parentPart=-1），用 drawable 索引隐藏（hiddenDrawables）
  var hiddenDrawableState = [];

  // Cubism3/4 的部件透明度不会自动写进 drawables.opacities（绘图对象透明度），
  // 因此隐藏部件需要把该部件下所有绘图对象的 opacity 直接置 0（每帧强制）。
  function c4ModelOf(core) {
    return core ? (core._model || core.model || null) : null;
  }

  function applyC4HiddenPart(core, partKey) {
    try {
      var model = c4ModelOf(core);
      if (!model || !model.drawables || !model.drawables.opacities) return false;
      var partIndex = -1;
      if (typeof partKey === "number") partIndex = partKey;
      else if (/^\d+$/.test(String(partKey))) partIndex = Number(partKey);
      if (partIndex < 0 && typeof core.getPartIndex === "function") partIndex = core.getPartIndex(String(partKey));
      if (partIndex < 0) return false;
      var parents = model.drawables.parentPartIndices;
      var opacities = model.drawables.opacities;
      if (!parents || !opacities) return false;
      var touched = false;
      for (var i = 0; i < parents.length; i += 1) {
        if (Number(parents[i]) === partIndex) {
          opacities[i] = 0;
          touched = true;
        }
      }
      return touched;
    } catch (e) { return false; }
  }

  function applyHiddenPartsForCore(core) {
    if (!core) return;
    var isC4 = Boolean(c4ModelOf(core) && c4ModelOf(core).drawables);
    for (var hi = 0; hi < hiddenPartState.length; hi += 1) {
      var part = hiddenPartState[hi];
      if (isC4) {
        applyC4HiddenPart(core, part);
      }
      // 同时把部件透明度置 0（Cubism2 直接生效；Cubism3/4 作为辅助状态）
      setPartOpacityKey(core, part, 0);
    }
  }

  // Cubism3/4 的 core.update() 会把 drawables.opacities 重置为 moc 初始值，
  // 所以隐藏背景部件必须在 update 之后写入：包一层 coreModel.update。
  function applyC4HiddenPartsDrawables(core) {
    if (!core) return;
    if (hiddenPartState.length || hiddenDrawableState.length) applyHiddenPartsForCore(core);
    if (debugC4HiddenPart !== null && debugC4HiddenPart !== undefined) {
      applyC4HiddenPart(core, debugC4HiddenPart);
    }
    if (debugC4HiddenDrawables.length) {
      try {
        var model = c4ModelOf(core);
        var opacities = model && model.drawables && model.drawables.opacities;
        if (opacities) {
          for (var i = 0; i < debugC4HiddenDrawables.length; i += 1) {
            var index = Number(debugC4HiddenDrawables[i]);
            if (index >= 0 && index < opacities.length) opacities[index] = 0;
          }
        }
      } catch (e) {}
    }
    if (hiddenDrawableState.length) {
      try {
        var coreModel = c4ModelOf(core);
        var ops = coreModel && coreModel.drawables && coreModel.drawables.opacities;
        if (ops) {
          for (var d = 0; d < hiddenDrawableState.length; d += 1) {
            var di = Number(hiddenDrawableState[d]);
            if (di >= 0 && di < ops.length) ops[di] = 0;
          }
        }
      } catch (e) {}
    }
  }

  function installC4DrawableHook(core) {
    try {
      if (!core || core.__petHiddenHookInstalled) return false;
      var model = c4ModelOf(core);
      if (!model || !model.drawables) return false;
      var originalUpdate = core.update;
      if (typeof originalUpdate !== "function") return false;
      core.update = function () {
        var result = originalUpdate.apply(this, arguments);
        try { applyC4HiddenPartsDrawables(core); } catch (e) {}
        return result;
      };
      core.__petHiddenHookInstalled = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function resolveHiddenParts(modelId) {
    var out = [];
    try {
      var entry = sceneEntry();
      if (entry && Array.isArray(entry.hiddenParts)) out = out.concat(entry.hiddenParts);
    } catch (e) {}
    try {
      var legacy = (appState && appState.config && appState.config.hiddenParts) || {};
      if (Array.isArray(legacy[modelId])) out = out.concat(legacy[modelId]);
    } catch (e) {}
    var seen = {};
    return out.filter(function(part) {
      var key = typeof part === "number" ? "i:" + part : "s:" + part;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function resolveHiddenDrawables(modelId) {
    var out = [];
    try {
      var entry = sceneEntry();
      if (entry && Array.isArray(entry.hiddenDrawables)) out = out.concat(entry.hiddenDrawables);
    } catch (e) {}
    try {
      var legacy = (appState && appState.config && appState.config.hiddenDrawables) || {};
      if (Array.isArray(legacy[modelId])) out = out.concat(legacy[modelId]);
    } catch (e) {}
    var seen = {};
    return out.filter(function(item) {
      var n = Number(item);
      if (!Number.isFinite(n) || n < 0) return false;
      var key = "d:" + n;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  function applyModelOverrides() {
    if (!live2dModel || !live2dModel.internalModel) return;
    var core = live2dModel.internalModel.coreModel;
    if (!core) return;
    // 场景参数（持久换装状态 / 过渡动画）先应用，调试覆盖拥有最高优先级
    try { applySceneOverrides(core); } catch (e) {}
    if (debugParamOverrides) {
      Object.keys(debugParamOverrides).forEach(function(key) {
        try {
          var v = Number(debugParamOverrides[key]);
          if (!Number.isFinite(v)) return;
          var idx = resolveParamIndex(core, key);
          if (idx >= 0 && typeof core.setParamFloat === "function") {
            core.setParamFloat(idx, v, 1);
          } else if (typeof core.setParameterValueById === "function") {
            core.setParameterValueById(String(key), v);
          }
        } catch (e) {}
      });
    }
    if (debugPartOverrides) {
      Object.keys(debugPartOverrides).forEach(function(key) {
        try {
          var op = Number(debugPartOverrides[key]);
          if (!Number.isFinite(op)) return;
          setPartOpacityKey(core, key, op);
        } catch (e) {}
      });
    }
    // 每模型隐藏部件（Tyrano 模型内嵌的游戏背景等）必须每帧强制为 0，
    // 否则模型动作/物理更新会把部件透明度改回来。
    applyHiddenPartsForCore(core);
  }
  function bindModelOverrideHandler() {
    if (_overrideHandlerBound) return;
    if (!live2dModel || !live2dModel.internalModel || typeof live2dModel.internalModel.on !== "function") return;
    try {
      live2dModel.internalModel.on("beforeModelUpdate", applyModelOverrides);
      _overrideHandlerBound = true;
    } catch (e) {}
  }
  function unbindModelOverrideHandler() {
    if (!_overrideHandlerBound) return;
    try {
      if (live2dModel && live2dModel.internalModel && typeof live2dModel.internalModel.off === "function") {
        live2dModel.internalModel.off("beforeModelUpdate", applyModelOverrides);
      }
    } catch (e) {}
    _overrideHandlerBound = false;
  }
  function applyPartOverridesNow() {
    try { applyModelOverrides(); } catch (e) {}
  }

  // 渲染一帧并读出画布像素（背景/部件探测用；不是每帧调用，只在自检时用）
  function extractStagePixels() {
    if (!live2dApp || !live2dModel) return null;
    live2dApp.renderer.render(live2dApp.stage);
    var canvas = live2dApp.renderer.extract.canvas(live2dApp.stage);
    var ctx = canvas.getContext("2d");
    var width = canvas.width;
    var height = canvas.height;
    if (!width || !height) return null;
    return { width: width, height: height, data: ctx.getImageData(0, 0, width, height).data };
  }

  // 用 drawable 顶点计算“实际绘制内容”包围盒（模型画布坐标，不依赖像素读取，结果稳定）。
  // Cubism2 模型的 drawable 可以画到内部画布外（头发/腿），缩放适配以此为准。
  // 注意：只对 Cubism2 core 生效 —— Cubism3/4 的 coreModel 是 WebAssembly，getDrawableVertices
  // 传入无效索引会直接崩溃（0xc0000005），因此 C3/4 继续用画布适配。
  function measureDrawableArtBoundsUnits() {
    if (!live2dModel || !live2dModel.internalModel) return null;
    var im = live2dModel.internalModel;
    // 仅 Cubism2：coreModel 提供 getTransformedPoints（纯 JS 运行时）
    if (!im.coreModel || typeof im.coreModel.getTransformedPoints !== "function") return null;
    if (typeof im.getDrawableVertices !== "function") return null;
    var mw = Number(im.width) || 1000;
    var mh = Number(im.height) || 1800;
    var count = 0;
    try {
      if (typeof im.getDrawableIDs === "function") {
        var ids = im.getDrawableIDs();
        count = Array.isArray(ids) ? ids.length : 0;
      }
    } catch (e) { count = 0; }
    if (!count) count = Number(im.drawDataCount) || 0;
    if (!count) return null;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var used = 0;
    var skipped = 0;
    for (var i = 0; i < count; i += 1) {
      // 跳过被手动隐藏的 drawable（C3 背景拆分等）
      if (hiddenDrawableState && hiddenDrawableState.indexOf(i) >= 0) { skipped += 1; continue; }
      var verts = null;
      try { verts = im.getDrawableVertices(i); } catch (e) { verts = null; }
      if (!verts || verts.length < 2) continue;
      var x0 = Infinity;
      var y0 = Infinity;
      var x1 = -Infinity;
      var y1 = -Infinity;
      for (var k = 0; k < verts.length; k += 2) {
        var vx = Number(verts[k]);
        var vy = Number(verts[k + 1]);
        if (!isFinite(vx) || !isFinite(vy)) continue;
        if (vx < x0) x0 = vx;
        if (vx > x1) x1 = vx;
        if (vy < y0) y0 = vy;
        if (vy > y1) y1 = vy;
      }
      if (!isFinite(x0)) continue;
      // 跳过覆盖整张画布的“背景”drawable（内嵌游戏背景等）
      if ((x1 - x0) >= mw * 0.92 && (y1 - y0) >= mh * 0.92) { skipped += 1; continue; }
      used += 1;
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
    }
    if (!isFinite(minX) || used === 0) return null;
    return {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX,
      height: maxY - minY,
      canvas: { width: mw, height: mh },
      drawables: { total: count, used: used, skipped: skipped }
    };
  }

  // 读取整个窗口绘制缓冲的“实际绘制内容”包围盒（CSS 坐标，含超出模型画布的头发/身体等）。
  // Cubism2 模型的 drawable 可以画到内部画布矩形之外，仅用画布尺寸无法判断是否被窗口裁切，
  // 因此缩放适配自检用 gl.readPixels 读全屏像素（只在 resize/加载时调用，不进入每帧循环）。
  function measureScreenArtBounds() {
    if (!live2dApp || !live2dModel) return null;
    try {
      var renderer = live2dApp.renderer;
      renderer.render(live2dApp.stage);
      var gl = renderer.gl;
      var w = renderer.width;
      var h = renderer.height;
      if (!gl || !w || !h) return null;
      var buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      var minX = w;
      var maxX = -1;
      var minRow = h;
      var maxRow = -1;
      for (var y = 0; y < h; y += 1) {
        var row = y * w * 4;
        for (var x = 0; x < w; x += 1) {
          if (buf[row + x * 4 + 3] > 16) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minRow) minRow = y;
            if (y > maxRow) maxRow = y;
          }
        }
      }
      if (maxX < 0) return null;
      var res = Number(renderer.resolution) || 1;
      // WebGL 缓冲原点在左下角：转换为屏幕左上角坐标系（CSS px）
      return {
        left: minX / res,
        top: (h - 1 - maxRow) / res,
        right: (maxX + 1) / res,
        bottom: (h - minRow) / res,
        width: (maxX - minX + 1) / res,
        height: (maxRow - minRow + 1) / res,
        screen: { width: w / res, height: h / res }
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  // 与基准画面比较：changed=有可见差异的像素比例；cornerChanged=四角区域变化比例
  // （背景/底图必然覆盖画面四角，人物部件通常不会，因此用四角变化识别内嵌背景）
  function pixelDiffAgainst(baseline, current, options) {
    var opts = options || {};
    var threshold = Number(opts.threshold) || 36;
    if (!baseline || !current) return null;
    var w = current.width;
    var h = current.height;
    if (baseline.width !== w || baseline.height !== h) return null;
    var a = baseline.data;
    var b = current.data;
    var total = w * h;
    var changed = 0;
    var cornerTotal = 0;
    var cornerChanged = 0;
    var cw = Math.max(1, Math.floor(w * 0.22));
    var ch = Math.max(1, Math.floor(h * 0.22));
    for (var y = 0; y < h; y += 1) {
      var rowOffset = y * w;
      var inCornerRow = y < ch || y >= h - ch;
      for (var x = 0; x < w; x += 1) {
        var p = (rowOffset + x) * 4;
        var diff = Math.abs(b[p] - a[p]) + Math.abs(b[p + 1] - a[p + 1]) + Math.abs(b[p + 2] - a[p + 2]) + Math.abs(b[p + 3] - a[p + 3]);
        var isChanged = diff > threshold;
        if (isChanged) changed += 1;
        if (inCornerRow && (x < cw || x >= w - cw)) {
          cornerTotal += 1;
          if (isChanged) cornerChanged += 1;
        }
      }
    }
    return {
      changedFraction: total ? changed / total : 0,
      cornerFraction: cornerTotal ? cornerChanged / cornerTotal : 0
    };
  }

  // ---------------------------------------------------------------
  // 场景系统：scenes.json -> 动作/原声/参数过渡；AI 标签/关键词触发
  // ---------------------------------------------------------------
  function sceneConfigNow() {
    return sceneRuntime.config || (appState && appState.sceneConfig) || null;
  }

  function sceneEntry() {
    var cfg = sceneConfigNow();
    if (!cfg || !cfg.models) return null;
    return cfg.models[loadedModelId] || cfg.models.__fallback__ || null;
  }

  // ---- 场景目录（scene-catalog）：63 个模型 = 可切换场景，带给 AI 的描述/whenToUse ----
  function catalogNow() {
    return (appState && appState.sceneCatalog) || null;
  }

  function catalogEntryForModel(model) {
    var cat = catalogNow();
    if (!cat || !cat.models || !model) return null;
    if (cat.models[model.id]) return cat.models[model.id];
    var key = (model.bundle || "") + "|" + (model.game || "") + "|" + (model.modelDirName || "");
    if (cat.dirIndex && cat.dirIndex[key] && cat.models[cat.dirIndex[key]]) return cat.models[cat.dirIndex[key]];
    var dir = String(model.modelDirName || "").toLowerCase();
    var found = null;
    if (dir) {
      Object.keys(cat.models).some(function(id) {
        var entry = cat.models[id];
        if (String(entry.modelDirName || "").toLowerCase() === dir) { found = entry; return true; }
        return false;
      });
    }
    return found;
  }

  function catalogEntries() {
    var cat = catalogNow();
    return cat && cat.models ? Object.keys(cat.models).map(function(id) { return cat.models[id]; }) : [];
  }

  function currentCatalogEntry() {
    var model = currentModelRecord || (appState && appState.selectedModel) || null;
    return catalogEntryForModel(model);
  }

  function catalogEntryBySceneId(sceneId) {
    var wanted = String(sceneId || "").trim();
    if (!wanted) return null;
    var cat = catalogNow();
    if (!cat || !cat.models) return null;
    if (cat.models[wanted]) return cat.models[wanted];
    var byDir = null;
    Object.keys(cat.models).some(function(id) {
      var entry = cat.models[id];
      if (entry.modelDirName === wanted || id.toLowerCase() === wanted.toLowerCase()) { byDir = entry; return true; }
      return false;
    });
    return byDir;
  }

  function sfwActiveNow() {
    return Boolean(window.__sfwState && window.__sfwState.active);
  }

  function isAuxiliaryModel(model) {
    var entry = catalogEntryForModel(model);
    return Boolean(entry && entry.kind === "auxiliary");
  }

  // 场景目录语义匹配：用户/AI 文本里出现场景标签或关键词（如「后位」「剖面」「抱枕」）
  // 过滤掉过于宽泛的词，避免「日常/立绘/女主」之类把闲聊误判成切场景
  var CATALOG_GENERIC_TERMS = {
    "日常": 1, "立绘": 1, "对话": 1, "女主": 1, "场景": 1, "辅助": 1, "角色": 1, "换装": 1, "游戏": 1, "模型": 1
  };

  function matchCatalogByText(text) {
    var source = String(text || "").toLowerCase();
    if (!source.trim()) return null;
    var entries = catalogEntries();
    var current = currentCatalogEntry();
    var best = null;
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var terms = [String(entry.sceneLabel || "")].concat(entry.keywords || []);
      for (var k = 0; k < terms.length; k += 1) {
        var term = String(terms[k] || "").trim().toLowerCase();
        if (!term || CATALOG_GENERIC_TERMS[term]) continue;
        if (term.length < 2) continue;
        if (source.indexOf(term) === -1) continue;
        // 同游戏/同角色场景优先（用户说「后位」时优先当前游戏的后背位场景）
        var sameGameBonus = current && entry.game === current.game ? 25 : 0;
        var sameCharBonus = current && entry.character === current.character ? 8 : 0;
        var score = term.length * 10 + sameGameBonus + sameCharBonus + (entry.kind === "auxiliary" ? 3 : 0) + (entry.nsfwOnly ? 1 : 0);
        if (!best || score > best.score) best = { entry: entry, term: term, score: score };
      }
    }
    return best;
  }

  function listScenes() {
    var entry = sceneEntry();
    return (entry && entry.scenes) || [];
  }

  function findSceneById(id) {
    var wanted = String(id || "").trim().toLowerCase();
    if (!wanted) return null;
    var scenes = listScenes();
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i] && String(scenes[i].id).toLowerCase() === wanted) return scenes[i];
    }
    return null;
  }

  function effectiveModelScale() {
    var entry = sceneEntry();
    var overrideScale = entry && entry.display ? entry.display.scale : null;
    if (overrideScale !== null && overrideScale !== undefined && Number.isFinite(Number(overrideScale))) {
      return Number(overrideScale);
    }
    return Number((appState && appState.config && appState.config.modelScale) || 1);
  }

  function sceneMotionMap() {
    if (_sceneMotionIndex && _sceneMotionIndex.modelId === loadedModelId) return _sceneMotionIndex.map;
    var defs = motionDefinitions();
    var map = {};
    Object.keys(defs).forEach(function(group) {
      (defs[group] || []).forEach(function(entry, index) {
        var file = String((entry && (entry.file || entry.File)) || "").replace(/\\/g, "/");
        var name = sceneMotionName(file);
        if (name && !map[name]) map[name] = { group: group, index: index, file: file, name: name };
      });
    });
    _sceneMotionIndex = { modelId: loadedModelId, map: map };
    return map;
  }

  // 动作文件路径 -> 动作名（C2 .mtn / C3 .motion3.json 都支持）
  function sceneMotionName(file) {
    return String(file || "")
      .replace(/\\/g, "/")
      .replace(/^.*\//, "")
      .replace(/\.(motion3\.json|mtn|json)$/i, "");
  }

  function sceneStateSnapshot() {
    var transition = null;
    if (sceneRuntime.transition) {
      transition = {
        keys: Object.keys(sceneRuntime.transition.to || {}),
        elapsedMs: Date.now() - sceneRuntime.transition.startedAt,
        durationMs: sceneRuntime.transition.durationMs,
        running: true
      };
    }
    return {
      modelId: loadedModelId,
      current: sceneRuntime.current,
      lastFinished: sceneRuntime.lastFinished,
      paramState: Object.assign({}, sceneRuntime.paramState),
      partState: Object.assign({}, sceneRuntime.partState),
      transition: transition,
      cooldownUntil: sceneRuntime.cooldownUntil,
      priorityCooldownUntil: sceneRuntime.priorityCooldownUntil,
      aiEnabled: sceneRuntime.aiEnabled,
      scenesCount: listScenes().length
    };
  }

  function reportSceneState() {
    var snapshot = sceneStateSnapshot();
    window.__petScene = snapshot;
    try { if (api && api.reportSceneState) api.reportSceneState(snapshot); } catch (e) {}
    return snapshot;
  }

  function showSceneToast(label, source, durationMs) {
    var el = document.getElementById("scene-toast");
    if (!el) return;
    var sourceLabel = source === "ai" ? "AI" : (source === "tray" ? "托盘" : (source === "panel" ? "面板" : (source === "debug" ? "调试" : (source === "aux" ? "提示" : (source === "catalog" ? "场景" : "")))));
    el.textContent = "🎬 " + label + (sourceLabel ? " · " + sourceLabel : "");
    el.classList.add("visible");
    if (_sceneToastTimer) clearTimeout(_sceneToastTimer);
    _sceneToastTimer = setTimeout(function() {
      el.classList.remove("visible");
      _sceneToastTimer = null;
    }, Number(durationMs) || 2600);
  }

  // 写单个模型参数（key 可以是 ParamN 字符串或索引）
  function writeModelParam(core, key, value) {
    var idx = resolveParamIndex(core, key);
    try {
      if (idx >= 0 && typeof core.setParamFloat === "function") {
        core.setParamFloat(idx, Number(value), 1);
        return true;
      }
    } catch (e) {}
    try {
      if (typeof core.setParameterValueById === "function") {
        core.setParameterValueById(String(key), Number(value));
        return true;
      }
    } catch (e) {}
    return false;
  }

  function applySceneOverrides(core) {
    if (!core) return;
    var transition = sceneRuntime.transition;
    if (transition) {
      var t = transition.durationMs > 0 ? (Date.now() - transition.startedAt) / transition.durationMs : 1;
      if (t >= 1) t = 1;
      // 缓入缓出，避免衣服/眼镜瞬间跳变
      var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var keys = Object.keys(transition.to || {});
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var fromVal = Number(transition.from[key]);
        var toVal = Number(transition.to[key]);
        if (!Number.isFinite(fromVal)) fromVal = toVal;
        writeModelParam(core, key, fromVal + (toVal - fromVal) * eased);
      }
      if (t >= 1) sceneRuntime.transition = null;
    } else {
      var stateKeys = Object.keys(sceneRuntime.paramState || {});
      for (var j = 0; j < stateKeys.length; j++) {
        writeModelParam(core, stateKeys[j], sceneRuntime.paramState[stateKeys[j]]);
      }
    }
    // 部件透明度覆盖
    var partKeys = Object.keys(sceneRuntime.partState || {});
    for (var k = 0; k < partKeys.length; k++) {
      try {
        setPartOpacityKey(core, partKeys[k], Number(sceneRuntime.partState[partKeys[k]]));
      } catch (e) {}
    }
  }

  function startSceneParamTransition(targets, durationMs) {
    var core = live2dModel && live2dModel.internalModel ? live2dModel.internalModel.coreModel : null;
    var from = {};
    Object.keys(targets || {}).forEach(function(key) {
      // 已持久化的参数状态是"当前视觉状态"的权威值（motion 更新会覆盖 core 参数，读 core 不可靠）
      if (sceneRuntime.paramState && Object.prototype.hasOwnProperty.call(sceneRuntime.paramState, key)) {
        from[key] = Number(sceneRuntime.paramState[key]);
        return;
      }
      var idx = core ? resolveParamIndex(core, key) : -1;
      var value = null;
      try { if (idx >= 0) value = Number(core.getParamFloat(idx)); } catch (e) {}
      from[key] = Number.isFinite(value) ? value : Number(targets[key]);
    });
    var ms = Math.max(0, Number(durationMs) || 0);
    sceneRuntime.paramState = Object.assign({}, sceneRuntime.paramState, targets);
    if (ms <= 0) {
      sceneRuntime.transition = null;
      applyPartOverridesNow();
      return;
    }
    sceneRuntime.transition = {
      from: from,
      to: Object.assign({}, targets),
      startedAt: Date.now(),
      durationMs: ms
    };
  }

  function stopSceneTimer() {
    if (sceneRuntime.timer) clearTimeout(sceneRuntime.timer);
    sceneRuntime.timer = null;
  }

  function playSceneSound(scene, playedMotionName) {
    try {
      if (!scene || scene.sound === "none") return false;
      if (!isSoundEnabled()) return false;
      // 优先按“实际播放的动作”找原声（自动生成的随机场景/动作组场景也能出声）
      if (playedMotionName && playSoundForMotion(playedMotionName)) return true;
      var names = (scene.motions || []).map(function(motion) { return String(motion.name || "").toLowerCase(); });
      if (!names.length) return false;
      var link = (modelLinks || []).find(function(item) {
        if (!item || (!item.sound && !item.soundUrl)) return false;
        var name = normalizeMotionKey(item.motion);
        return names.some(function(n) { return normalizeMotionKey(n) === name; });
      });
      if (link) return playLinkedSound(link);
    } catch (e) {}
    return false;
  }

  function playSceneMotion(scene) {
    try {
      var motions = (scene && scene.motions) || [];
      if (!motions.length) return null;
      var map = sceneMotionMap();
      for (var i = 0; i < motions.length; i++) {
        var target = map[String(motions[i].name || "")];
        if (!target) continue;
        live2dModel.motion(target.group, target.index);
        window.__lastSceneMotion = { name: target.name || motions[i].name, group: target.group, index: target.index };
        return window.__lastSceneMotion;
      }
    } catch (e) {}
    return null;
  }

  // 自动生成场景用：按 motionFilter / linkedOnly 随机挑一个动作播放
  function playRandomSceneMotion(scene) {
    try {
      if (!live2dModel) return null;
      var defs = motionDefinitions();
      var linkedNames = {};
      (modelLinks || []).forEach(function(link) {
        if (link && (link.sound || link.soundUrl)) linkedNames[normalizeMotionKey(link.motion)] = true;
      });
      var filterRe = null;
      try { if (scene && scene.motionFilter) filterRe = new RegExp(scene.motionFilter); } catch (e) { filterRe = null; }
      var pool = [];
      Object.keys(defs).forEach(function(group) {
        (defs[group] || []).forEach(function(entry, index) {
          var name = sceneMotionName(entry && (entry.file || entry.File));
          if (!name) return;
          if (filterRe && !filterRe.test(name)) return;
          if (scene && scene.linkedOnly && !linkedNames[normalizeMotionKey(name)]) return;
          pool.push({ group: group, index: index, name: name });
        });
      });
      if (!pool.length) {
        // linkedOnly 场景没有关联动作时退化为全量随机，避免点了没反应
        if (scene && scene.linkedOnly) return playRandomSceneMotion(Object.assign({}, scene, { linkedOnly: false }));
        return null;
      }
      var pick = pool[Math.floor(Math.random() * pool.length)];
      live2dModel.motion(pick.group, pick.index);
      window.__lastSceneMotion = pick;
      return pick;
    } catch (e) {
      return null;
    }
  }

  function stopSceneRuntime(options) {
    var opts = options || {};
    stopSceneTimer();
    sceneRuntime.transition = null;
    if (opts.resetState !== false) {
      sceneRuntime.paramState = {};
      sceneRuntime.partState = {};
    }
    sceneRuntime.current = null;
    _sceneMotionIndex = null;
    if (opts.report !== false) reportSceneState();
  }

  function executeScene(sceneId, options) {
    options = options || {};
    var scene = findSceneById(sceneId);
    if (!scene) return { ok: false, reason: "scene_not_found", sceneId: String(sceneId || "") };
    if (!live2dModel) return { ok: false, reason: "model_not_loaded", sceneId: scene.id };
    var now = Date.now();
    var source = options.source || "ui";
    // 实验性场景（启发式半脱）：只能从场景面板/调试手动触发；AI/托盘/随机不自动选
    if (scene.experimental && source !== "panel" && source !== "debug") {
      return { ok: false, reason: "experimental_manual_only", sceneId: scene.id, message: "实验性场景（启发式半脱）仅支持手动点击" };
    }
    if (scene.nsfwOnly && sfwActiveNow()) {
      return { ok: false, reason: "nsfw_required", sceneId: scene.id, message: "该场景为 NSFW 限定，请先开启 NSFW" };
    }
    var cfg = sceneConfigNow() || {};
    var aiCfg = (cfg && cfg.ai) || {};
    if (source === "ai") {
      if (!sceneRuntime.aiEnabled) return { ok: false, reason: "ai_disabled", sceneId: scene.id };
      var cooldownUntil = (Number(scene.priority) || 1) >= 3
        ? sceneRuntime.priorityCooldownUntil
        : sceneRuntime.cooldownUntil;
      if (!options.force && now < cooldownUntil) {
        return { ok: false, reason: "cooldown", retryInMs: cooldownUntil - now, sceneId: scene.id };
      }
      sceneRuntime.cooldownUntil = now + (Number(aiCfg.cooldownMs) || 6000);
      if ((Number(scene.priority) || 1) >= 3) {
        sceneRuntime.priorityCooldownUntil = now + (Number(aiCfg.priorityCooldownMs) || 15000);
      }
    }
    stopSceneTimer();
    sceneRuntime.transition = null;
    var hasParams = Object.keys(scene.params || {}).length > 0;
    if (hasParams) startSceneParamTransition(scene.params, scene.transitionMs);
    if (scene.parts && Object.keys(scene.parts).length) {
      sceneRuntime.partState = Object.assign({}, sceneRuntime.partState, scene.parts);
    }
    var motion = playSceneMotion(scene);
    if (!motion && scene.randomMotion) motion = playRandomSceneMotion(scene);
    playSceneSound(scene, motion && motion.name);
    var durationMs = Number(scene.durationMs) || 0;
    if (!durationMs) {
      durationMs = motion ? 4200 : (hasParams ? Math.max(1000, Number(scene.transitionMs) || 0) + 600 : 2000);
    }
    sceneRuntime.current = {
      id: scene.id,
      label: scene.label,
      category: scene.category,
      priority: Number(scene.priority) || SCENE_CATEGORY_PRIORITY[scene.category] || 1,
      source: source,
      startedAt: now,
      durationMs: durationMs,
      persistent: scene.persistent !== false,
      hint: scene.hint || "",
      evidence: scene.evidence || null,
      motion: motion ? motion.name : null,
      params: Object.assign({}, scene.params || {}),
      running: true
    };
    sceneRuntime.lastSource = source;
    showSceneToast(scene.label, source);
    reportSceneState();
    // 场景会改变姿态/内容包围盒：节流刷新气泡 follow 锚点（强制重测）
    scheduleOverlayLayout(260, true);
    var self = scene;
    sceneRuntime.timer = setTimeout(function() {
      sceneRuntime.timer = null;
      sceneRuntime.lastFinished = {
        id: self.id,
        label: self.label,
        category: self.category,
        finishedAt: Date.now(),
        source: source
      };
      if (sceneRuntime.current && sceneRuntime.current.id === self.id) {
        sceneRuntime.current = Object.assign({}, sceneRuntime.current, { running: false, finishedAt: Date.now() });
      }
      // 结束回到待机：动作自然播完，随机待机动作由原有调度继续接管
      reportSceneState();
    }, durationMs);
    return { ok: true, scene: sceneRuntime.current, transition: sceneRuntime.transition ? true : false };
  }

  function resetSceneState(options) {
    var opts = options || {};
    var entry = sceneEntry();
    var resetParams = (entry && entry.resetParams) || {};
    stopSceneTimer();
    sceneRuntime.current = null;
    sceneRuntime.lastFinished = null;
    sceneRuntime.partState = {};
    sceneRuntime.priorityCooldownUntil = 0;
    sceneRuntime.cooldownUntil = 0;
    if (Object.keys(resetParams).length) {
      // 用短过渡恢复默认状态（例如衣服穿回、眼镜戴回），并把默认值作为持久参数状态保留，
      // 避免残留动作/随机动作再次把服装参数改回去。
      var targets = Object.assign({}, resetParams);
      var from = {};
      var core = live2dModel && live2dModel.internalModel ? live2dModel.internalModel.coreModel : null;
      Object.keys(targets).forEach(function(key) {
        var idx = core ? resolveParamIndex(core, key) : -1;
        var value = null;
        try { if (idx >= 0) value = Number(core.getParamFloat(idx)); } catch (e) {}
        from[key] = Number.isFinite(value) ? value : Number(targets[key]);
      });
      sceneRuntime.paramState = Object.assign({}, resetParams);
      sceneRuntime.transition = { from: from, to: targets, startedAt: Date.now(), durationMs: Math.max(200, Number(opts.transitionMs) || 700) };
      var selfTransition = sceneRuntime.transition;
      setTimeout(function() {
        if (sceneRuntime.transition === selfTransition) {
          sceneRuntime.transition = null;
          reportSceneState();
        }
      }, selfTransition.durationMs + 80);
    } else {
      sceneRuntime.paramState = {};
    }
    reportSceneState();
    return { ok: true, resetParams: resetParams || {} };
  }

  // ---- AI 回复 -> 场景：用户指令 > 显式标签 > 关键词 ----
  function matchSceneByText(text) {
    var source = String(text || "").toLowerCase();
    if (!source.trim()) return null;
    var scenes = listScenes();
    var best = null;
    for (var i = 0; i < scenes.length; i++) {
      var scene = scenes[i];
      if (!scene) continue;
      for (var k = 0; k < (scene.keywords || []).length; k++) {
        var keyword = scene.keywords[k];
        if (!keyword || source.indexOf(keyword) === -1) continue;
        var priority = Number(scene.priority) || SCENE_CATEGORY_PRIORITY[scene.category] || 1;
        var score = keyword.length * 10 + priority * 3;
        if (!best || score > best.score) best = { scene: scene, keyword: keyword, score: score };
      }
    }
    return best;
  }

  function detectSceneFromText(replyText, options) {
    var opts = options || {};
    // 1) 用户消息里的明确动作指令优先
    if (opts.userText) {
      // 1a) 场景目录语义（「后位」「剖面」「抱枕」等 = 切换场景/模型）
      var catalogMatch = matchCatalogByText(opts.userText);
      if (catalogMatch) return { catalogEntry: catalogMatch.entry, matchedBy: "catalog-user", term: catalogMatch.term };
      var userMatch = matchSceneByText(opts.userText);
      if (userMatch) return { scene: userMatch.scene, matchedBy: "user", keyword: userMatch.keyword };
    }
    // 2) AI 显式标签（当前场景 id 或场景目录 model_id）
    if (opts.tagId) {
      var tagged = findSceneById(opts.tagId);
      if (tagged) return { scene: tagged, matchedBy: "tag" };
      var catalogTag = catalogEntryBySceneId(opts.tagId);
      if (catalogTag) return { catalogEntry: catalogTag, matchedBy: "catalog-tag" };
    }
    // 3) 关键词回退（中/日）
    if (replyText) {
      var replyMatch = matchSceneByText(replyText);
      if (replyMatch) return { scene: replyMatch.scene, matchedBy: "keyword", keyword: replyMatch.keyword };
    }
    return null;
  }

  function handleAiReply(replyText, options) {
    var opts = options || {};
    if (!sceneRuntime.aiEnabled) return { ok: false, reason: "ai_disabled" };
    var detection = detectSceneFromText(replyText, opts);
    if (!detection) return { ok: false, reason: "no_match" };
    if (detection.catalogEntry) {
      var catEntry = detection.catalogEntry;
      if (catEntry.nsfwOnly && sfwActiveNow()) {
        // NSFW 关闭：拒绝并回退当前模型的普通场景，不报错
        var fallbackId = "";
        var currentScenes = listScenes();
        for (var fi = 0; fi < currentScenes.length; fi += 1) {
          if (!currentScenes[fi].experimental && !currentScenes[fi].nsfwOnly) { fallbackId = currentScenes[fi].id; break; }
        }
        var fallback = fallbackId ? executeScene(fallbackId, { source: "ai", force: true }) : null;
        return {
          ok: false,
          reason: "nsfw_required",
          fallback,
          detection: { matchedBy: detection.matchedBy, sceneLabel: catEntry.sceneLabel, modelId: catEntry.modelId },
          message: "「" + catEntry.sceneLabel + "」为 NSFW 限定场景，已回退普通场景"
        };
      }
      return triggerCatalogScene(catEntry.modelId, null).then(function(result) {
        return Object.assign({ detection: { matchedBy: detection.matchedBy, sceneLabel: catEntry.sceneLabel, modelId: catEntry.modelId } }, result);
      });
    }
    var result = executeScene(detection.scene.id, {
      source: "ai",
      force: Boolean(opts.force)
    });
    return Object.assign({ detection: detection, matchedBy: detection.matchedBy }, result);
  }

  // ---- AI 能力清单 + function calling 工具执行器（模型无关；能力随当前模型变化）----
  var toolCallLog = [];
  function buildAiCapabilities() {
    try {
      if (!window.PetAiControl) return null;
      var entry = sceneEntry();
      var model = (appState && appState.selectedModel) || null;
      var caps = window.PetAiControl.buildCapabilities({
        modelId: loadedModelId || "",
        modelName: (model && model.name) || (entry && entry.displayName) || loadedModelId || "",
        modelEntry: entry || {},
        motionMap: sceneMotionMap(),
        models: (appState && appState.models) || [],
        // 场景目录：当前模型语义 + 63 个可切换场景（描述/whenToUse/NSFW）
        catalog: {
          path: (appState && appState.sceneCatalogPath) || "",
          current: catalogEntryForModel(model),
          entries: catalogEntries()
        },
        sfwActive: sfwActiveNow(),
        // 「AI 自动切换场景/动作」总开关：关闭时 ai-control 不生成场景类工具与说明
        sceneAiEnabled: Boolean(appState && appState.config && appState.config.sceneAutoEnabled !== false),
        // AI 缩放能力：仅管理页「允许 AI 控制桌宠缩放」开启时生成 set_scale 工具
        scale: {
          percent: currentPetScalePercent(),
          min: 25,
          max: 200,
          controllable: Boolean(appState && appState.config && appState.config.aiControl && appState.config.aiControl.scaleEnabled === true)
        }
      });
      caps.tools = window.PetAiControl.buildTools(caps);
      caps.brief = window.PetAiControl.buildBrief(caps);
      return caps;
    } catch (e) {
      return null;
    }
  }

  function reportAiCapabilities() {
    var caps = buildAiCapabilities();
    window.__petCapabilities = caps;
    try { if (api && api.reportCapabilities) api.reportCapabilities(caps); } catch (e) {}
    return caps;
  }

  function resolveSceneMotionByName(name) {
    var key = sceneMotionName(name);
    var map = sceneMotionMap();
    return map[key] || map[name] || null;
  }

  function findAccessoryConfig(accessoryId) {
    var entry = sceneEntry();
    var list = (entry && entry.aiControl && entry.aiControl.accessories) || [];
    var wanted = String(accessoryId || "");
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === wanted) return list[i];
    }
    return null;
  }

  // 场景目录切换：切模型 + 播放代表场景（主进程执行窗口/配置，宠物窗收到 pet:catalog-scene 后执行）
  function triggerCatalogScene(modelId, sceneId) {
    var cat = catalogNow();
    if (!cat) return Promise.resolve({ ok: false, reason: "catalog_missing" });
    var entry = catalogEntryBySceneId(modelId);
    if (!entry) return Promise.resolve({ ok: false, reason: "scene_not_found", sceneId: String(modelId || "") });
    if (entry.kind === "auxiliary" && sfwActiveNow()) {
      return Promise.resolve({ ok: false, reason: "nsfw_required", message: "辅助视角模型（非人物立绘）需先开启 NSFW", sceneId: entry.modelId });
    }
    if (entry.nsfwOnly && sfwActiveNow()) {
      return Promise.resolve({ ok: false, reason: "nsfw_required", message: "该场景为 NSFW 限定，请先开启 NSFW", sceneId: entry.modelId });
    }
    if (!api.playCatalogScene) return Promise.resolve({ ok: false, reason: "unsupported" });
    var targetScene = sceneId || entry.defaultScene || "idle";
    return api.playCatalogScene(entry.modelId, targetScene).then(function(result) {
      if (result && result.ok) {
        pendingCatalogScene = null;
        showSceneToast("场景：" + (entry.sceneLabel || entry.modelId), "ai", 2600);
      }
      return result;
    }, function(error) {
      return { ok: false, reason: "error", message: String((error && error.message) || error), sceneId: entry.modelId };
    });
  }

  function executeToolCall(name, rawArgs) {
    var args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    var startedAt = Date.now();
    function done(result) {
      var rec = { name: name, args: args, result: result, at: startedAt, ms: Date.now() - startedAt };
      toolCallLog.push(rec);
      if (toolCallLog.length > 50) toolCallLog = toolCallLog.slice(-50);
      window.__petToolLog = toolCallLog;
      return result;
    }
    var caps = buildAiCapabilities();
    try {
      if (name === "play_scene") {
        var wantedId = String(args.scene_id || "");
        // 1) 当前模型的预设场景
        if (findSceneById(wantedId)) {
          var result = executeScene(wantedId, { source: "ai-tool", force: true });
          if (result && result.ok === false && result.reason === "experimental_manual_only") {
            return done({ ok: false, tool: name, reason: "experimental_manual_only", message: "实验性场景（启发式半脱）不支持自动触发，请让用户手动在面板「实验性」分类点击" });
          }
          if (result && result.ok === false && result.reason === "nsfw_required") {
            return done({ ok: false, tool: name, reason: "nsfw_required", message: "该场景为 NSFW 限定，请先在托盘开启 NSFW" });
          }
          return done(Object.assign({ tool: name }, result));
        }
        // 2) 场景目录（切模型 + 播放代表场景）
        var catEntry = catalogEntryBySceneId(wantedId);
        if (catEntry) {
          return triggerCatalogScene(catEntry.modelId, null).then(function(res) {
            return done(Object.assign({ tool: name, catalog_scene: true }, res));
          });
        }
        return done({ ok: false, tool: name, reason: "scene_not_found", message: "场景不存在：" + wantedId + "（可先调用 list_scenes 查询场景目录）" });
      }
      if (name === "list_scenes") {
        var query = String(args.query || "").toLowerCase();
        var entries = catalogEntries().filter(function(entry) {
          if (!query) return true;
          var haystack = [entry.sceneLabel, entry.description, entry.whenToUse, entry.game, entry.category, (entry.keywords || []).join(" ")].join(" ").toLowerCase();
          return haystack.indexOf(query) !== -1;
        });
        return done({
          ok: true,
          tool: name,
          total: entries.length,
          scenes: entries.slice(0, 80).map(function(entry) {
            return {
              scene_id: entry.modelId,
              scene_label: entry.sceneLabel,
              game: entry.game,
              character: entry.character,
              kind: entry.kind,
              nsfw_only: Boolean(entry.nsfwOnly),
              description: String(entry.description || "").slice(0, 160),
              when_to_use: String(entry.whenToUse || "").slice(0, 140)
            };
          })
        });
      }
      if (name === "list_motions") {
        var prefix = String(args.prefix || "");
        var names = Object.keys(sceneMotionMap()).filter(function(item) {
          return !prefix || item.indexOf(prefix) === 0;
        }).sort();
        return done({ ok: true, tool: name, total: names.length, motions: names.slice(0, 120), truncated: names.length > 120 });
      }
      if (name === "play_motion") {
        if (!live2dModel) return done({ ok: false, tool: name, reason: "model_not_loaded" });
        var target = null;
        if (args.motion_name) {
          target = resolveSceneMotionByName(args.motion_name);
        } else if (args.group !== undefined && args.index !== undefined) {
          var defs = motionDefinitions();
          var list = defs[String(args.group)] || [];
          var index = Number(args.index);
          if (index >= 0 && index < list.length) {
            target = { group: String(args.group), index: index, file: String((list[index] && (list[index].file || list[index].File)) || "") };
          }
        }
        if (!target) {
          return done({ ok: false, tool: name, reason: "not_supported", message: "动作不存在（可先调用 list_motions 查询动作名）" });
        }
        live2dModel.motion(target.group, target.index);
        var motionName = sceneMotionName(target.file) || String(args.motion_name || "");
        window.__lastSceneMotion = { name: motionName, group: target.group, index: target.index };
        // 按模型 links 播放该动作的原声（尊重声音开关）
        playSoundForMotion(motionName);
        sceneRuntime.current = {
          id: "tool:play_motion", label: "动作 " + motionName, category: "动作", source: "ai-tool",
          startedAt: Date.now(), durationMs: 4200, running: true, persistent: false, motion: motionName
        };
        showSceneToast("动作 " + motionName, "ai");
        reportSceneState();
        return done({ ok: true, tool: name, motion: window.__lastSceneMotion });
      }
      if (name === "set_clothing") {
        if (!caps || !caps.clothing) {
          return done({ ok: false, tool: name, reason: "not_supported", message: "当前模型不支持服装切换（无服装参数/素材）" });
        }
        var level = Number(args.level);
        if (!Number.isFinite(level)) {
          return done({ ok: false, tool: name, reason: "bad_args", message: "level 必须是数字（" + caps.clothing.min + "~" + caps.clothing.max + "）" });
        }
        level = Math.max(Number(caps.clothing.min), Math.min(Number(caps.clothing.max), level));
        var clothingParams = {};
        clothingParams[caps.clothing.param] = level;
        startSceneParamTransition(clothingParams, 800);
        sceneRuntime.current = {
          id: "tool:set_clothing", label: "服装等级 " + level, category: "换装", source: "ai-tool",
          startedAt: Date.now(), durationMs: 1200, running: true, persistent: true, params: clothingParams
        };
        showSceneToast("服装等级 " + level, "ai");
        reportSceneState();
        return done({ ok: true, tool: name, level: level, param: caps.clothing.param });
      }
      if (name === "set_accessory") {
        var accessoryId = String(args.accessory_id || "");
        var accessoryMeta = null;
        if (caps && caps.accessories) {
          accessoryMeta = caps.accessories.filter(function(item) { return String(item.id) === accessoryId; })[0] || null;
        }
        if (!accessoryMeta) {
          return done({ ok: false, tool: name, reason: "not_supported", message: "当前模型没有该饰品（可用：" + ((caps && caps.accessories) || []).map(function(a) { return a.id; }).join(",") + "）" });
        }
        var accessoryConfig = findAccessoryConfig(accessoryId) || {};
        var on = Boolean(args.on);
        var accessoryParams = on ? (accessoryConfig.onParams || {}) : (accessoryConfig.offParams || {});
        if (Object.keys(accessoryParams).length) startSceneParamTransition(accessoryParams, 400);
        var accessoryMotionName = on ? accessoryConfig.onMotion : accessoryConfig.offMotion;
        if (accessoryMotionName && live2dModel) {
          var accessoryMotion = resolveSceneMotionByName(accessoryMotionName);
          if (accessoryMotion) live2dModel.motion(accessoryMotion.group, accessoryMotion.index);
        }
        sceneRuntime.current = {
          id: "tool:set_accessory", label: (accessoryMeta.label || accessoryId) + (on ? " 戴上" : " 摘下"), category: "换装",
          source: "ai-tool", startedAt: Date.now(), durationMs: 1200, running: true, persistent: true, params: accessoryParams
        };
        sceneRuntime.paramState = Object.assign({}, sceneRuntime.paramState, accessoryParams);
        showSceneToast((accessoryMeta.label || accessoryId) + (on ? " 戴上" : " 摘下"), "ai");
        reportSceneState();
        return done({ ok: true, tool: name, accessory_id: accessoryId, on: on });
      }
      if (name === "switch_model") {
        if (!api.selectModel) return done({ ok: false, tool: name, reason: "not_supported" });
        var targetModelId = String(args.model_id || "");
        var models = (appState && appState.models) || [];
        var targetModel = models.filter(function(item) { return item.id === targetModelId; })[0] || null;
        if (!targetModel) {
          return done({ ok: false, tool: name, reason: "not_supported", message: "模型不存在：" + targetModelId + "（可调用 list_scenes 查看场景目录）" });
        }
        var targetCatalogEntry = catalogEntryForModel(targetModel);
        if (targetCatalogEntry && targetCatalogEntry.kind === "auxiliary" && sfwActiveNow()) {
          return done({ ok: false, tool: name, reason: "nsfw_required", message: "辅助视角模型（非人物立绘）需要先开启 NSFW" });
        }
        return api.selectModel(targetModelId).then(function() {
          return done({ ok: true, tool: name, model_id: targetModelId });
        }, function(error) {
          return done({ ok: false, tool: name, reason: "error", message: String((error && error.message) || error) });
        });
      }
      if (name === "set_scale") {
        // AI 调整桌宠缩放：仅管理页「允许 AI 控制桌宠缩放」开启时才会下发该工具；
        // 执行器再校验一次开关，防止模型幻觉/文本标签协议绕过工具列表直接改缩放。
        if (!(appState && appState.config && appState.config.aiControl && appState.config.aiControl.scaleEnabled === true)) {
          return done({ ok: false, tool: name, reason: "disabled", message: "用户未开启「允许 AI 控制桌宠缩放」" });
        }
        var requestedPercent = Number(args.percent);
        if (!Number.isFinite(requestedPercent)) {
          return done({ ok: false, tool: name, reason: "bad_args", message: "percent 需为 25~200 的数字" });
        }
        var targetPercent = Math.max(25, Math.min(200, Math.round(requestedPercent)));
        if (!api || !api.setPetScale) return done({ ok: false, tool: name, reason: "not_supported" });
        return Promise.resolve(api.setPetScale(targetPercent / 100)).then(function (result) {
          showSceneToast("桌宠缩放 " + targetPercent + "%", "scale", 2000);
          return done({ ok: true, tool: name, percent: targetPercent, apply: result || null });
        }, function (error) {
          return done({ ok: false, tool: name, reason: "error", message: String((error && error.message) || error) });
        });
      }
      return done({ ok: false, tool: name, reason: "not_supported", message: "未知工具：" + name });
    } catch (e) {
      return done({ ok: false, tool: name, reason: "error", message: String((e && e.message) || e) });
    }
  }

  function motionCount(group) {
    var definitions = motionDefinitions();
    var entries = definitions && definitions[group];
    return Array.isArray(entries) ? entries.length : 0;
  }

  function pickRandomMotion(groups) {
    var candidates = [];
    for (var i = 0; i < groups.length; i++) {
      var count = motionCount(groups[i]);
      for (var index = 0; index < count; index++) {
        candidates.push({ group: groups[i], index: index });
      }
    }
    if (!candidates.length) {
      var definitions = motionDefinitions();
      Object.keys(definitions).forEach(function(group) {
        var count = motionCount(group);
        for (var index = 0; index < count; index++) {
          candidates.push({ group: group, index: index });
        }
      });
    }
    return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  }

  function playRandomBodyMotion(mode) {
    // 辅助/剖面模型（非人物立绘）不参与随机动作池，只在用户手动选择时展示
    if (isAuxiliaryModel(currentModelRecord)) return false;
    var groups = mode === "speaking"
      ? ["talk", "tap_body", "Tap", "tap", "flick_head"]
      : ["idle", "Idle", "rest", "sleepy", "tap_body", "Tap", "tap"];
    var motion = pickRandomMotion(groups);
    if (!motion) return false;
    // 桌宠改造：尽量只播安全动作（对话/过渡），找不到安全动作时才保持原逻辑
    var safe = safeMotionIndices(motion.group);
    if (safe.length) {
      var defs = motionDefinitions();
      var entries = defs[motion.group] || [];
      var file = entries[motion.index] && (entries[motion.index].file || entries[motion.index].File);
      if (!file || !SAFE_MOTION_RE.test(String(file))) {
        motion.index = safe[Math.floor(Math.random() * safe.length)];
      }
    }
    playLive2dMotion(motion.group, motion.index, null, { silent: true });
    return true;
  }

  function hasActiveAgentStatus() {
    var item = primaryStatusItem(appState && appState.status);
    var kind = item && item.kind ? item.kind : "idle";
    return kind !== "idle" && kind !== "complete" && kind !== "completed";
  }

  function isTavernAudioPlaying() {
    return Boolean(tavernAudioEl && !tavernAudioEl.paused && !tavernAudioEl.ended);
  }

  function scheduleRandomBodyMotion(delay) {
    if (randomBodyMotionPaused) return;
    if (randomBodyMotionTimer) clearTimeout(randomBodyMotionTimer);
    randomBodyMotionTimer = setTimeout(function() {
      randomBodyMotionTimer = null;
      if (live2dModel && !randomBodyMotionPaused && !tavernBusy && !isTavernAudioPlaying() && !hasActiveAgentStatus() && Date.now() >= dragReactionUntil) {
        playRandomBodyMotion("idle");
      }
      if (live2dModel && !randomBodyMotionPaused) scheduleRandomBodyMotion(9000 + Math.random() * 9000);
    }, delay || (7000 + Math.random() * 7000));
  }

  function clearRandomBodyMotion() {
    if (randomBodyMotionTimer) clearTimeout(randomBodyMotionTimer);
    randomBodyMotionTimer = null;
  }

  function scheduleSpeakingBodyMotion(delay) {
    if (speakingBodyMotionTimer) clearTimeout(speakingBodyMotionTimer);
    speakingBodyMotionTimer = setTimeout(function() {
      speakingBodyMotionTimer = null;
      if (tavernAudioEl && !tavernAudioEl.paused && !tavernAudioEl.ended) {
        playRandomBodyMotion("speaking");
        scheduleSpeakingBodyMotion(3200 + Math.random() * 2600);
      }
    }, delay || 250);
  }

  function clearSpeakingBodyMotion() {
    if (speakingBodyMotionTimer) clearTimeout(speakingBodyMotionTimer);
    speakingBodyMotionTimer = null;
  }

  async function triggerRandomChat() {
    if (!live2dModel || tavernBusy) return;
    // 桌宠改造：未配置聊天 API Key 时跳过主动搭话，保证纯离线可用
    var tavernCfg = (appState && appState.config && appState.config.tavern) || {};
    if (!tavernCfg.textApiKey) return;
    if (Date.now() - lastHoverGreetAt < 7000) return;
    lastHoverGreetAt = Date.now();
    tavernBusy = true;
    try {
      initTavernAudio();
      var result = await api.tavernChat([
        { role: "user", content: "（请以呆呆的身份，主动对老公随机说一句自然的话。不要固定套路，每次都要不一样。要短。）" }
      ]);
      if (!result.ok) throw new Error(result.error || "chat failed");
      var reply = result.reply;
      // AI 主动搭话：标签/关键词触发场景（无 API Key 时此函数已提前 return，不会报错）
      handleAiReply(reply, { tagId: result.scene });
      var tts = await api.tavernTts(reply);
      if (tts.ok && tts.url && tavernAudioEl && tavernAudioCtx) {
        if (tavernAudioCtx.state === "suspended") await tavernAudioCtx.resume();
        tavernAudioEl.src = tts.url;
        tavernAudioEl.onplay = function() { startLipSync(); scheduleSpeakingBodyMotion(120); };
        tavernAudioEl.onended = function() { stopLipSync(); };
        tavernAudioEl.onerror = function() { stopLipSync(); };
        await tavernAudioEl.play();
      }
    } catch(e) {
      console.error("hover greet error:", e);
    } finally {
      tavernBusy = false;
    }
  }

  var _lastSoundTime = 0;
  function resolveSoundUrl(actionId) {
    var sounds = (appState && appState.selectedSounds) || [];
    if (!sounds.length) return null;
    var actions = (appState && appState.config && appState.config.soundActions) || {};
    var selection = actions[actionId] || "random";
    if (selection === "none") return null;
    if (selection !== "random") {
      var selected = sounds.find(function(s) { return s.id === selection; });
      if (selected) return selected.url;
    }
    return sounds[Math.floor(Math.random() * sounds.length)].url;
  }

  function playSoundUrl(url) {
    if (!url) return;
    var audio = new Audio(url);
    audio.volume = 0.4;
    audio.play().catch(function() {});
  }

  function tryPlayModelSound(actionId, preview) {
    if (!preview && appState && appState.config && appState.config.soundEnabled === false) return;
    var now = Date.now();
    if (!preview && now - _lastSoundTime < 800) return;
    _lastSoundTime = now;
    try {
      playSoundUrl(resolveSoundUrl(actionId));
    } catch (e) {}
  }

  function motionForStatus(kind) {
    if (kind === "thinking") return "flick_head";
    if (kind === "running-tool" || kind === "tool_use") return "tap_body";
    if (kind === "replying") return "tap_body";
    if (kind === "complete" || kind === "completed") return "tap_body";
    if (kind === "error") return "flick_head";
    if (kind === "waiting-permission" || kind === "waiting-input") return "flick_head";
    return "idle";
  }

  function primaryStatusItem(status) {
    const sources = ((status && status.sources) || []).slice();
    sources.sort((a, b) => Number(b.timestamp || Date.parse(b.updatedAt || "") || 0) - Number(a.timestamp || Date.parse(a.updatedAt || "") || 0));
    return sources.find((item) => item.kind && item.kind !== "idle") || sources.find((item) => item.text) || null;
  }

  function updateLive2dMotion(status, force) {
    const item = primaryStatusItem(status);
    const kind = item && item.kind ? item.kind : "idle";
    const motion = motionForStatus(kind);
    const changed = force || kind !== statusMotionKind;

    if (changed && statusMotionTimer) {
      clearInterval(statusMotionTimer);
      statusMotionTimer = null;
    }

    if (motion !== "idle" && changed) {
      playLive2dMotion(motion, 0, kind);
    }
    statusMotionKind = kind;

    if (!statusMotionTimer && (kind === "thinking" || kind === "waiting-permission" || kind === "waiting-input")) {
      statusMotionTimer = setInterval(() => playLive2dMotion("flick_head", 1), 2500);
    }
  }

  var SOUND_ACTIONS = [
    { id: "thinking", name: "思考中", detail: "AI 正在推理时触发" },
    { id: "tool_use", name: "运行工具", detail: "执行 shell_command 等工具时触发" },
    { id: "replying", name: "回复中", detail: "AI 正在输出回复时触发" },
    { id: "complete", name: "完成", detail: "任务完成后最后一次气泡更新时触发" },
    { id: "error", name: "出错", detail: "会话报错时触发" },
    { id: "waiting", name: "等待确认", detail: "等待用户授权/确认时触发" },
    { id: "drag", name: "拖动宠物", detail: "用户拖动窗口时触发" }
  ];

  function renderSoundSettings(state) {
    var sounds = state.selectedSounds || [];
    var options = [
      '<option value="random">随机播放</option>',
      '<option value="none">此动作静音</option>',
      sounds.map(function(s) { return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>'; }).join("")
    ].join("");

    if (!sounds.length) {
      return [
        '<section class="section"><h2>音效配置</h2>',
        '<div class="sound-empty">声音库还没有音频。点击下方按钮打开声音目录，放入 .mp3 /.wav /.ogg 文件，会自动出现在这里。</div>',
        '<div style="margin-top:8px"><button id="open-sounds-dir">打开声音目录</button></div>',
        '</section>'
      ].join("");
    }

    var rows = SOUND_ACTIONS.map(function(action) {
      var val = (state.config.soundActions && state.config.soundActions[action.id]) || "random";
      var hasValue = val === "random" || val === "none" || sounds.some(function(s) { return s.id === val; });
      if (!hasValue) val = "random";
      return [
        '<div class="sound-row">',
        '  <div><strong>' + escapeHtml(action.name) + '</strong><span class="muted">' + escapeHtml(action.detail) + '</span></div>',
        '  <select data-sound-action="' + escapeHtml(action.id) + '">' + options + '</select>',
        '  <button type="button" data-preview-sound="' + escapeHtml(action.id) + '">试听</button>',
        '</div>'
      ].join("");
    }).join("");

    return [
      '<section class="section">',
      '  <div class="section-head"><h2>音效配置</h2><button id="open-sounds-dir">打开声音目录</button></div>',
      '  <div class="sound-list">' + rows + '</div>',
      '</section>'
    ].join("");
  }

  function selectedOption(value, expected) {
    return value === expected ? " selected" : "";
  }

  // 角色注册表：模型 → 角色（与主进程 characters payload 的 byModel/byGame 一致）
  function characterForModelState(model) {
    var chars = appState && appState.characters;
    if (!chars || !chars.characters) return null;
    var id = model && model.id && chars.byModel ? chars.byModel[model.id] : "";
    if (!id && model && model.game && chars.byGame) id = chars.byGame[model.game];
    if (!id) return null;
    for (var i = 0; i < chars.characters.length; i++) {
      if (chars.characters[i].id === id) return chars.characters[i];
    }
    return null;
  }

  // 角色与角色卡：角色（提示词）→ 模型（一个模型 = 一个场景）→ 场景/动作统计
  function renderCharacterSettings(state) {
    var chars = (state && state.characters) || {};
    var list = chars.characters || [];
    var models = (state && state.models) || [];
    var modelById = {};
    models.forEach(function (model) { modelById[model.id] = model; });
    var activeId = managerCharacterId && list.some(function (c) { return c.id === managerCharacterId; })
      ? managerCharacterId
      : (chars.activeCharacterId || (list[0] && list[0].id) || "");
    var character = null;
    for (var ci = 0; ci < list.length; ci++) if (list[ci].id === activeId) character = list[ci];
    var currentModel = state && state.selectedModel;
    var currentCharacter = currentModel ? characterForModelState(currentModel) : null;
    var options = list.map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '"' + (item.id === activeId ? " selected" : "") + ">" +
        escapeHtml(item.name || item.id) + "（" + escapeHtml(item.game || "") + "，" + (item.modelIds || []).length + " 个模型）" +
        "</option>";
    }).join("");
    var stats = chars.stats || {};
    var sceneCount = 0;
    var actionCount = 0;
    var chips = "";
    if (character) {
      chips = (character.modelIds || []).map(function (modelId) {
        var model = modelById[modelId];
        var entry = model ? catalogEntryForModel(model) : null;
        var sceneCfg = state && state.sceneConfig && state.sceneConfig.models ? state.sceneConfig.models[modelId] : null;
        if (sceneCfg && Array.isArray(sceneCfg.scenes)) sceneCount += sceneCfg.scenes.length;
        if (model && Number(model.motionCount)) actionCount += Number(model.motionCount);
        var isCurrent = Boolean(state && state.config && state.config.selectedModelId === modelId);
        var label = model ? (model.displayName || model.name || modelId) : modelId;
        var sceneLabel = entry ? entry.sceneLabel : "（没有场景目录条目）";
        var auxBadge = entry && entry.kind === "auxiliary" ? '<span class="chip-badge">辅助</span>' : "";
        var nsfwBadge = entry && entry.nsfwOnly ? '<span class="chip-badge nsfw">NSFW</span>' : "";
        return '<button type="button" class="character-model-chip' + (isCurrent ? " active" : "") + '"' +
          ' data-use-character-model="' + escapeHtml(modelId) + '"' + (isCurrent ? " disabled" : "") +
          ' title="' + escapeHtml((entry && entry.description) || sceneLabel) + '">' +
          '<span class="chip-name">' + (isCurrent ? "▶ " : "") + escapeHtml(label) + "</span>" +
          '<span class="chip-scene">' + escapeHtml(sceneLabel) + "</span>" + auxBadge + nsfwBadge +
          "</button>";
      }).join("");
    }
    var activeHint = currentCharacter
      ? "当前模型使用角色卡：" + currentCharacter.name + (currentCharacter.overridden ? "（已自定义）" : "")
      : "当前模型没有匹配角色，聊天将使用下方「通用兜底角色卡」。";
    var prompt = character ? character.prompt : "";
    var canReset = Boolean(character && character.overridden);
    return [
      '<section class="section character-section">',
      '  <h2>角色与角色卡 <span class="muted">角色 → 模型（场景）→ 动作</span></h2>',
      '  <div class="character-head">',
      '    <label class="config-field"><span><strong>角色</strong><span class="muted">每个角色一张角色卡提示词；切换模型时自动套用该模型的角色</span></span><select id="character-select">' + options + "</select></label>",
      '    <div class="character-summary muted">' + escapeHtml("共 " + (stats.characters || list.length) + " 个角色 / " + (stats.modelsCovered || 0) + " 个模型") +
          " · " + escapeHtml(activeHint) + "</div>",
      '  </div>',
      '  <label class="config-field config-field-wide"><span><strong>角色卡提示词 · <span id="character-name-label">' + escapeHtml(character ? character.name : "（未选择角色）") + "</span></strong><span class=\"muted\">" +
          "只保存到本机 user-data/characters.json，不调用任何接口；切换角色可分别编辑</span></span><textarea id=\"character-prompt\" rows=\"6\" data-character-id=\"" + escapeHtml(activeId) + "\" placeholder=\"这个角色是谁、性格、怎么称呼用户…\">" + escapeHtml(prompt) + "</textarea></label>",
      '  <div class="character-actions">',
      '    <button id="character-save" class="primary">保存角色卡</button>',
      '    <button id="character-reset" class="ghost"' + (canReset ? "" : " disabled") + ">恢复内置角色卡</button>",
      '    <span id="character-save-status" class="muted">' + escapeHtml(managerCharacterStatus || "") + "</span>",
      '  </div>',
      '  <div class="character-models">',
      '    <div class="character-models-head"><strong>该角色的模型 / 场景</strong><span class="muted">' +
          (character ? "模型 " + character.modelIds.length + " 个 · 场景配置 " + sceneCount + " 个 · 动作 " + actionCount + " 个" : "未选择角色") +
          " · 点击切换</span></div>",
      '    <div class="character-model-chips">' + (chips || '<span class="muted">暂无模型</span>') + "</div>",
      '  </div>',
      "</section>"
    ].join("");
  }

  function renderTavernSettings(state) {
    var tavern = (state.config && state.config.tavern) || {};
    var voice = tavern.voice || "zh_female_tianmeitaozi_uranus_bigtts";
    var model = tavern.textModel || "deepseek-chat";
    return [
      '<section class="section">',
      '  <h2>聊天模型与语音</h2>',
      '  <div class="tavern-settings">',
      '    <label class="config-field"><span><strong>文字接口</strong><span class="muted">OpenAI 兼容 /chat/completions 地址</span></span><input id="tavern-text-base-url" type="text" value="' + escapeHtml(tavern.textBaseUrl || "https://api.deepseek.com/v1") + '" /></label>',
      '    <label class="config-field"><span><strong>文字 API Key</strong><span class="muted">仅保存到本机 config.json，不写入源码</span></span><input id="tavern-text-api-key" type="password" value="' + escapeHtml(tavern.textApiKey || "") + '" /></label>',
      '    <label class="config-field"><span><strong>文字模型</strong><span class="muted">DeepSeek V4 Flash 建议使用 deepseek-chat，已关闭深度思考</span></span><select id="tavern-text-model"><option value="deepseek-chat"' + selectedOption(model, "deepseek-chat") + '>DeepSeek V4 Flash / deepseek-chat</option><option value="default"' + selectedOption(model, "default") + '>OpenAI 兼容 default</option><option value="custom"' + (model !== "deepseek-chat" && model !== "default" ? " selected" : "") + '>自定义</option></select></label>',
      '    <label class="config-field"><span><strong>自定义模型 ID</strong><span class="muted">选择“自定义”时使用</span></span><input id="tavern-custom-model" type="text" value="' + escapeHtml(model !== "deepseek-chat" && model !== "default" ? model : "") + '" /></label>',
      '    <label class="config-field"><span><strong>回复长度</strong><span class="muted">越短延迟越低，建议 120-200</span></span><input id="tavern-max-tokens" type="number" min="32" max="2048" step="16" value="' + escapeHtml(tavern.textMaxTokens || 160) + '" /></label>',
      '    <label class="config-field"><span><strong>温度</strong><span class="muted">角色聊天建议 0.7-0.9</span></span><input id="tavern-temperature" type="number" min="0" max="2" step="0.1" value="' + escapeHtml(tavern.textTemperature || 0.8) + '" /></label>',
      '    <label class="config-field"><span><strong>火山 AppID</strong><span class="muted">语音合成应用 ID</span></span><input id="tavern-tts-appid" type="text" value="' + escapeHtml(tavern.ttsAppId || "3931757810") + '" /></label>',
      '    <label class="config-field"><span><strong>火山 Token</strong><span class="muted">仅保存到本机 config.json</span></span><input id="tavern-tts-token" type="password" value="' + escapeHtml(tavern.ttsToken || "") + '" /></label>',
      '    <label class="config-field"><span><strong>音色</strong><span class="muted">桃桃为默认音色</span></span><select id="tavern-voice"><option value="zh_female_tianmeitaozi_uranus_bigtts"' + selectedOption(voice, "zh_female_tianmeitaozi_uranus_bigtts") + '>甜美桃桃</option><option value="zh_female_vv_uranus_bigtts"' + selectedOption(voice, "zh_female_vv_uranus_bigtts") + '>Vivi</option><option value="zh_female_linjianvhai_uranus_bigtts"' + selectedOption(voice, "zh_female_linjianvhai_uranus_bigtts") + '>邻家女孩</option><option value="custom"' + (["zh_female_tianmeitaozi_uranus_bigtts","zh_female_vv_uranus_bigtts","zh_female_linjianvhai_uranus_bigtts"].indexOf(voice) === -1 ? " selected" : "") + '>自定义</option></select></label>',
      '    <label class="config-field"><span><strong>自定义音色 ID</strong><span class="muted">选择“自定义”时使用</span></span><input id="tavern-custom-voice" type="text" value="' + escapeHtml(["zh_female_tianmeitaozi_uranus_bigtts","zh_female_vv_uranus_bigtts","zh_female_linjianvhai_uranus_bigtts"].indexOf(voice) === -1 ? voice : "") + '" /></label>',
      '    <label class="config-field"><span><strong>语速</strong><span class="muted">1 为正常</span></span><input id="tavern-tts-speed" type="number" min="0.5" max="3" step="0.1" value="' + escapeHtml(tavern.ttsSpeed || 1) + '" /></label>',
      '  </div>',
      '  <details class="tavern-fallback">',
      '    <summary><strong>通用兜底角色卡</strong><span class="muted">没有匹配到角色的模型（例如手工导入的新模型）使用这张</span></summary>',
      '    <label class="config-field config-field-wide"><span><strong>兜底提示词</strong><span class="muted">要求只输出要说的话，不要动作描写</span></span><textarea id="tavern-role-prompt" rows="5">' + escapeHtml(tavern.rolePrompt || "") + "</textarea></label>",
      '  </details>',
      '</section>'
    ].join("");
  }

  // 全局快捷键设置区：录制 + 冲突提示 + 恢复默认
  // 状态来源：主进程 hotkeyStatus（{ id, name, accelerator, registered, error, effective, rollback? }[]）
  function hotkeyStatusOf(state, id) {
    var list = (state && state.hotkeyStatus) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function renderHotkeySettings(state) {
    var hotkeys = (state.config && state.config.hotkeys) || {};
    var actions = state.hotkeyActions || [];
    var enabled = hotkeys.enabled !== false;
    var rows = actions.map(function (action) {
      var status = hotkeyStatusOf(state, action.id);
      var value = hotkeys[action.id] || "";
      var cls = "hotkey-status";
      var text = "未注册";
      if (!enabled) {
        cls += " muted";
        text = "快捷键总开关已关";
      } else if (status && status.registered) {
        cls += " ok";
        text = status.rollback ? "已保留原快捷键「" + status.rollback + "」" : "✓ 已注册";
      } else if (status && status.error) {
        cls += " error";
        text = "⚠ " + status.error;
      }
      return [
        '<div class="hotkey-row" data-hotkey-row="' + action.id + '">',
        '  <div class="hotkey-meta"><strong>' + escapeHtml(action.name) + '</strong><span class="muted">' + escapeHtml(action.detail || "") + '</span></div>',
        '  <input class="hotkey-input" id="hotkey-' + action.id + '" data-hotkey-id="' + action.id + '" type="text" value="' + escapeHtml(value) + '" placeholder="点「录制」或手动输入" spellcheck="false" autocomplete="off" />',
        '  <button type="button" class="ghost hotkey-capture" data-hotkey-capture="' + action.id + '">录制</button>',
        '  <span class="' + cls + '" id="hotkey-status-' + action.id + '">' + escapeHtml(text) + '</span>',
        '</div>'
      ].join("");
    }).join("");
    return [
      '<section class="section hotkey-section">',
      '  <h2>全局快捷键 <span class="muted">桌宠不在前台也生效</span></h2>',
      '  <label class="setting-row">',
      '    <span><strong>启用全局快捷键</strong><span class="muted">关闭后仍可用托盘/管理页操作</span></span>',
      '    <span class="switch-control"><input id="hotkeys-enabled" type="checkbox" /><span class="switch-track" aria-hidden="true"></span></span>',
      '  </label>',
      '  <div class="hotkey-grid">' + rows + '</div>',
      '  <div class="hotkey-actions">',
      '    <label class="hotkey-step"><span class="muted">放大/缩小步进</span><input id="hotkey-step" type="number" min="1" max="25" step="1" value="' + escapeHtml(hotkeys.step || 5) + '" /><span class="muted">%</span></label>',
      '    <label class="hotkey-step"><span class="muted">精细步进</span><input id="hotkey-fine-step" type="number" min="1" max="10" step="1" value="' + escapeHtml(hotkeys.fineStep || 1) + '" /><span class="muted">%</span></label>',
      '    <button type="button" class="primary" id="hotkeys-save">保存并重新注册</button>',
      '    <button type="button" class="ghost" id="hotkeys-reset">恢复默认</button>',
      '    <button type="button" class="ghost" id="hotkeys-refresh">重新注册</button>',
      '    <span class="muted" id="hotkey-save-status"></span>',
      '  </div>',
      '  <p class="muted hotkey-help">录制：点「录制」后 10 秒内按下组合键（必须含 Ctrl/Alt/Shift），Esc 取消。保存前会先试注册：被其它程序占用、或与其它动作重复的组合键会标红，并自动保留原来的快捷键。改键若失败，旧键仍可用。</p>',
      '</section>'
    ].join("");
  }

  // 聊天文本 / 历史设置区
  function renderChatSettings(state) {
    var chat = (state.config && state.config.chat) || {};
    var ttsConfigured = Boolean(state.ttsConfigured);
    var info = state.chatHistoryInfo || {};
    var modes = state.chatTextModes || ["always", "when-tts-off", "off"];
    var labels = {
      "always": "总是显示文本气泡（语音照常播放）",
      "when-tts-off": "仅 TTS 未配置/失败时显示文本",
      "off": "只用语音，不显示文本"
    };
    var options = modes.map(function (mode) {
      return '<option value="' + mode + '"' + selectedOption(chat.textMode || "always", mode) + '>' + escapeHtml(labels[mode] || mode) + '</option>';
    }).join("");
    return [
      '<section class="section chat-settings">',
      '  <h2>聊天文本与历史 <span class="muted">' + (ttsConfigured ? "TTS 已配置，文字仍可同时显示" : "TTS 未配置 · 仅文字模式可用") + '</span></h2>',
      '  <div class="settings-grid">',
      '    <label class="setting-row"><span><strong>文本输出</strong><span class="muted">没有火山 TTS Token 时也能看到回复</span></span><select id="chat-text-mode">' + options + '</select></label>',
      '    <label class="setting-row"><span><strong>气泡停留</strong><span class="muted">毫秒；语音在播时不会提前消失</span></span><input id="chat-bubble-ms" type="number" min="1500" max="60000" step="500" value="' + escapeHtml(chat.bubbleMs || 9000) + '" /></label>',
      '    <label class="setting-row"><span><strong>历史上限</strong><span class="muted">每个角色保留最近 N 条（20~2000）</span></span><input id="chat-history-limit" type="number" min="20" max="2000" step="10" value="' + escapeHtml(chat.historyLimit || 300) + '" /></label>',
      '    <label class="setting-row"><span><strong>持久化聊天记录</strong><span class="muted">写入 user-data/chat-history.json，重启后仍可查看</span></span><span class="switch-control"><input id="chat-persist" type="checkbox" /><span class="switch-track" aria-hidden="true"></span></span></label>',
      '  </div>',
      '  <div class="chat-actions">',
      '    <button type="button" class="ghost" id="chat-open-panel">打开聊天记录面板</button>',
      '    <button type="button" class="danger" id="chat-clear-history">清空全部记录</button>',
      '    <span class="muted" id="chat-history-stats">' + (info && info.messages ? "已有 " + info.messages + " 条 / " + info.characters + " 个角色" : "还没有聊天记录") + '</span>',
      '  </div>',
      '</section>'
    ].join("");
  }

  // 聊天悬浮层设置区：气泡跟随模型（follow/manual）+ 重置位置（位置在宠物窗内拖动调整）
  function renderOverlaySettings(state) {
    var overlay = (state.config && state.config.overlay) || {};
    var follow = !(overlay.bubble && overlay.bubble.mode === "manual");
    var locked = overlay.locked === true;
    return [
      '<section class="section overlay-settings">',
      '  <h2>聊天悬浮层 <span class="muted">气泡/输入框/记录面板按窗口百分比保存位置</span></h2>',
      '  <div class="settings-grid">',
      '    <label class="setting-row"><span><strong>气泡跟随模型头顶</strong><span class="muted">开启：文字气泡自动贴在模型头顶、不挡模型；关闭：使用拖动后的固定位置</span></span><span class="switch-control"><input id="overlay-bubble-follow" type="checkbox"' + (follow ? ' checked' : '') + ' /><span class="switch-track" aria-hidden="true"></span></span></label>',
      '  </div>',
      '  <div class="chat-actions">',
      '    <button type="button" class="ghost" id="overlay-reset">重置悬浮层位置</button>',
      '    <span class="muted" id="overlay-status">' + (locked ? "布局已锁定（config.overlay.locked=true），宠物窗内暂不可拖动" : "在桌宠窗口里拖动文字气泡、输入条 ⠿ 把手或聊天记录面板标题栏即可调整位置") + '</span>',
      '  </div>',
      '  <p class="muted">位置以相对宠物窗口的百分比保存，窗口缩放后相对位置不变；拖动气泡后会自动切换为「固定位置」（manual），可用上方开关恢复跟随。</p>',
      '</section>'
    ].join("");
  }

  // 与 config-store DEFAULT_HOTKEYS 保持一致的恢复默认值
  var HOTKEY_RESET_DEFAULTS = {
    enabled: true,
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

  function bindHotkeySettings(state) {
    var enabledEl = document.getElementById("hotkeys-enabled");
    var stepEl = document.getElementById("hotkey-step");
    var fineEl = document.getElementById("hotkey-fine-step");
    var saveBtn = document.getElementById("hotkeys-save");
    var resetBtn = document.getElementById("hotkeys-reset");
    var refreshBtn = document.getElementById("hotkeys-refresh");
    var statusEl = document.getElementById("hotkey-save-status");
    var inputs = Array.prototype.slice.call(document.querySelectorAll(".hotkey-input"));
    var recording = false;
    function setStatus(text) { if (statusEl) statusEl.textContent = text || ""; }
    function collect() {
      var hotkeys = {
        enabled: enabledEl ? enabledEl.checked : true,
        step: stepEl ? Math.min(25, Math.max(1, Number(stepEl.value) || 5)) : 5,
        fineStep: fineEl ? Math.min(10, Math.max(1, Number(fineEl.value) || 1)) : 1
      };
      inputs.forEach(function (input) {
        hotkeys[input.getAttribute("data-hotkey-id")] = String(input.value || "").trim();
      });
      return hotkeys;
    }
    function save() {
      var hotkeys = collect();
      setStatus("正在注册…");
      api.setConfig({ hotkeys: hotkeys }).then(function (next) {
        appState = next || appState;
        var failed = ((appState && appState.hotkeyStatus) || []).filter(function (item) {
          return item.accelerator && !item.registered;
        });
        setStatus(failed.length ? "已保存；" + failed.length + " 个组合键未注册成功（见下方红字）" : "已保存并注册成功");
        if (appState) renderManager(appState);
      });
    }
    inputs.forEach(function (input) {
      var id = input.getAttribute("data-hotkey-id");
      var recordBtn = document.querySelector('[data-hotkey-capture="' + id + '"]');
      if (recordBtn) {
        recordBtn.addEventListener("click", function () {
          if (recording || !api.recordHotkey) return;
          recording = true;
          hotkeyCaptureId = id;
          input.classList.add("recording");
          recordBtn.disabled = true;
          recordBtn.textContent = "录制中…";
          setStatus("请按下组合键（Esc 取消，10 秒超时）");
          api.recordHotkey().then(function (result) {
            recording = false;
            hotkeyCaptureId = "";
            input.classList.remove("recording");
            recordBtn.disabled = false;
            recordBtn.textContent = "录制";
            if (result && result.ok && result.accelerator) {
              input.value = result.accelerator;
              setStatus("已录制：" + result.accelerator + "（点「保存并重新注册」生效）");
            } else {
              setStatus((result && result.error) || "未录制到组合键");
            }
          });
        });
      }
      input.addEventListener("change", function () {
        input.value = String(input.value || "").trim();
      });
    });
    if (enabledEl) enabledEl.addEventListener("change", save);
    if (saveBtn) saveBtn.addEventListener("click", save);
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      setStatus("正在重新注册…");
      api.refreshHotkeys().then(function () { renderManager(appState); });
    });
    if (resetBtn) resetBtn.addEventListener("click", function () {
      var defaults = HOTKEY_RESET_DEFAULTS;
      inputs.forEach(function (input) {
        var id = input.getAttribute("data-hotkey-id");
        if (defaults[id]) input.value = defaults[id];
      });
      if (enabledEl) enabledEl.checked = true;
      if (stepEl) stepEl.value = String(defaults.step);
      if (fineEl) fineEl.value = String(defaults.fineStep);
      setStatus("已填入默认快捷键，点「保存并重新注册」生效");
    });
  }

  function bindChatSettings(state) {
    var modeEl = document.getElementById("chat-text-mode");
    var bubbleEl = document.getElementById("chat-bubble-ms");
    var limitEl = document.getElementById("chat-history-limit");
    var persistEl = document.getElementById("chat-persist");
    var statsEl = document.getElementById("chat-history-stats");
    var openBtn = document.getElementById("chat-open-panel");
    var clearBtn = document.getElementById("chat-clear-history");
    if (persistEl) persistEl.checked = (state.config.chat && state.config.chat.persist) !== false;
    function save() {
      var chat = {
        textMode: modeEl ? modeEl.value : "always",
        bubbleMs: bubbleEl ? Number(bubbleEl.value) : 9000,
        historyLimit: limitEl ? Number(limitEl.value) : 300,
        persist: persistEl ? persistEl.checked : true
      };
      api.setConfig({ chat: chat }).then(function (next) { appState = next || appState; });
    }
    [modeEl, bubbleEl, limitEl, persistEl].forEach(function (el) {
      if (el) el.addEventListener("change", save);
    });
    if (openBtn) {
      openBtn.addEventListener("click", function () {
        if (api.openChatPanel) api.openChatPanel();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (!window.confirm("清空全部角色的聊天记录？此操作不可恢复。")) return;
        api.clearChatHistory("").then(function (res) {
          if (statsEl) statsEl.textContent = res && res.ok ? "聊天记录已清空" : "清空失败";
          if (appState) renderManager(appState);
        });
      });
    }
  }

  // 聊天悬浮层设置绑定：气泡跟随开关 + 重置位置（保存完整 overlay 对象，避免浅合并丢字段）
  function bindOverlaySettings(state) {
    var followEl = document.getElementById("overlay-bubble-follow");
    var resetBtn = document.getElementById("overlay-reset");
    var statusEl = document.getElementById("overlay-status");
    function setStatus(text) { if (statusEl) statusEl.textContent = text || ""; }
    if (followEl) {
      followEl.addEventListener("change", function () {
        var cfg = overlayConfig();
        cfg.bubble.mode = followEl.checked ? "follow" : "manual";
        setStatus("正在保存…");
        api.setConfig({ overlay: cfg }).then(function (next) {
          appState = next || appState;
          setStatus(followEl.checked ? "已开启：气泡跟随模型头顶" : "已关闭：气泡使用固定位置（可在宠物窗拖动）");
        });
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        setStatus("正在重置…");
        api.setConfig({ overlay: OVERLAY_DEFAULTS }).then(function (next) {
          appState = next || appState;
          if (appState) renderManager(appState);
        });
      });
    }
  }

  function renderManager(state) {
    root.innerHTML = `
      <div class="manager-shell">
        <aside class="sidebar">
          <h1>Daidai Live2D Pet</h1>
          <p>后台管理、模型导入、状态 adapter。当前项目独立于成熟 ClaudePet。</p>
        </aside>
        <main class="main-panel">
          <div class="toolbar">
            <button class="primary" id="import-model">导入 Live2D 目录</button>
            <button id="open-models">打开模型目录</button>
            <button id="show-pet">显示宠物</button>
            <button class="danger" id="hide-pet">隐藏宠物</button>
          </div>
          <section class="section">
            <h2>应用设置</h2>
            <div class="settings-grid">
              <label class="setting-row">
                <span>
                  <strong>总在最前</strong>
                  <span class="muted">宠物窗口保持在其他窗口之上</span>
                </span>
                <input id="always-on-top" type="checkbox" />
              </label>
              <label class="setting-row">
                <span>
                  <strong>透明度</strong>
                  <span class="muted">调整宠物窗口整体透明度</span>
                </span>
                <input id="opacity" type="range" min="0.2" max="1" step="0.05" />
              </label>
              <label class="setting-row">
                <span>
                  <strong>桌宠缩放</strong>
                  <span class="muted">25%~200%，1% 粒度；滑块 / 数字框 / Ctrl+滚轮（±1%，按住 Shift ±5%）/ 托盘 / 全局快捷键 同步</span>
                </span>
                <span class="scale-control">
                  <input id="pet-scale" type="range" min="25" max="200" step="1" />
                  <input id="pet-scale-number" type="number" min="25" max="200" step="1" title="输入 25~200 的百分比" />
                  <span id="pet-scale-value" class="muted">100%</span>
                </span>
              </label>
              <div class="setting-row scale-presets-row">
                <span>
                  <strong>快速档位</strong>
                  <span class="muted" id="pet-scale-effective"></span>
                </span>
                <span class="scale-presets" id="pet-scale-presets">
                  <button type="button" class="ghost" data-scale-preset="25">25%</button>
                  <button type="button" class="ghost" data-scale-preset="50">50%</button>
                  <button type="button" class="ghost" data-scale-preset="75">75%</button>
                  <button type="button" class="ghost" data-scale-preset="100">100%</button>
                  <button type="button" class="ghost" data-scale-preset="125">125%</button>
                  <button type="button" class="ghost" data-scale-preset="150">150%</button>
                  <button type="button" class="ghost" data-scale-preset="175">175%</button>
                  <button type="button" class="ghost" data-scale-preset="200">200%</button>
                  <button type="button" class="ghost" data-scale-preset="fit">适应屏幕</button>
                </span>
              </div>
              <label class="setting-row">
                <span>
                  <strong>显示背景（默认关）</strong>
                  <span class="muted">桌宠默认完全透明；开启后仅显示半透明底板，不显示模型自带背景</span>
                </span>
                <input id="show-background" type="checkbox" />
              </label>
              <label class="setting-row">
                <span>
                  <strong>声音</strong>
                  <span class="muted">点击或动作切换时播放模型音效</span>
                </span>
                <span class="switch-control">
                  <input id="sound-enabled" type="checkbox" />
                  <span class="switch-track" aria-hidden="true"></span>
                </span>
              </label>
              <label class="setting-row">
                <span>
                  <strong>🔒 SFW 毛玻璃遮罩</strong>
                  <span class="muted">默认开启：模型画面加毛玻璃，防止私密细节外露；关闭后为 NSFW 清晰画面（托盘菜单也可切换）</span>
                </span>
                <span class="switch-control">
                  <input id="sfw-enabled" type="checkbox" />
                  <span class="switch-track" aria-hidden="true"></span>
                </span>
              </label>
              <label class="setting-row">
                <span>
                  <strong>允许 AI 控制桌宠缩放</strong>
                  <span class="muted">开启后 AI 可在聊天中把桌宠缩放到 25%~200%；关闭时 AI 不会改缩放</span>
                </span>
                <span class="switch-control">
                  <input id="ai-scale-enabled" type="checkbox" />
                  <span class="switch-track" aria-hidden="true"></span>
                </span>
              </label>
              <label class="setting-row">
                <span>
                  <strong>状态服务</strong>
                  <span class="muted">默认兼容本地成熟宠物 bridge 的 /status</span>
                </span>
                <input id="status-url" type="text" />
              </label>
            </div>
          </section>
          ${renderSoundSettings(state)}
          ${renderCharacterSettings(state)}
          ${renderTavernSettings(state)}
          ${renderHotkeySettings(state)}
          ${renderChatSettings(state)}
          ${renderOverlaySettings(state)}
          <section class="section">
            <h2>Live2D 模型 <span id="model-stats" class="muted"></span></h2>
            <div class="model-toolbar">
              <input id="model-search" type="search" placeholder="搜索游戏 / 模型 / 路径…" />
              <select id="model-kind-filter" title="按模型格式筛选">
                <option value="all">全部格式</option>
                <option value="cubism2">Cubism 2</option>
                <option value="cubism3+">Cubism 3/4</option>
              </select>
              <button id="rescan-models" class="primary">⟳ 重新扫描模型库</button>
              <button id="open-generated-scenes" class="ghost">打开自动场景配置</button>
              <button id="open-model-display" class="ghost">显示/隐藏部件配置</button>
            </div>
            <div id="model-scan-status" class="muted model-scan-status"></div>
            <div id="model-list" class="model-list"></div>
          </section>
        </main>
      </div>
    `;

    const alwaysOnTop = document.getElementById("always-on-top");
    const opacity = document.getElementById("opacity");
    const soundEnabled = document.getElementById("sound-enabled");
    const sfwEnabled = document.getElementById("sfw-enabled");
    const statusUrl = document.getElementById("status-url");
    alwaysOnTop.checked = Boolean(state.config.alwaysOnTop);
    opacity.value = String(state.config.opacity || 1);
    soundEnabled.checked = state.config.soundEnabled !== false;
    statusUrl.value = state.config.statusPollUrl || "";
    var petScaleSlider = document.getElementById("pet-scale");
    var petScaleNumber = document.getElementById("pet-scale-number");
    var petScaleValue = document.getElementById("pet-scale-value");
    var petScaleEffective = document.getElementById("pet-scale-effective");
    var petScalePresets = document.getElementById("pet-scale-presets");
    function paintScale(pct, commit) {
      var next = Math.min(200, Math.max(25, Math.round(Number(pct) || 100)));
      if (petScaleSlider) petScaleSlider.value = String(next);
      if (petScaleNumber) petScaleNumber.value = String(next);
      if (petScaleValue) petScaleValue.textContent = next + "%";
      if (petScaleEffective) {
        var apply = state.petScale && state.petScale.lastApply;
        if (apply && apply.clamped) {
          petScaleEffective.textContent = "受屏幕限制，实际显示 " + Math.round(Number(apply.scale || 1) * 100) + "%";
        } else {
          petScaleEffective.textContent = "窗口按底边中心缩放，不超出屏幕工作区";
        }
      }
      if (commit) api.setConfig({ petScale: next / 100 });
    }
    paintScale(
      Math.round(
        Number((state.petScale && state.petScale.scale) || state.config.petScale || 1) * 100
      ),
      false
    );
    if (petScaleSlider) {
      petScaleSlider.addEventListener("input", function() {
        paintScale(petScaleSlider.value, false);
      });
      petScaleSlider.addEventListener("change", function() {
        paintScale(petScaleSlider.value, true);
      });
    }
    if (petScaleNumber) {
      petScaleNumber.addEventListener("change", function() {
        paintScale(petScaleNumber.value, true);
      });
    }
    if (petScalePresets) {
      petScalePresets.addEventListener("click", function(event) {
        var btn = event.target && event.target.closest ? event.target.closest("button[data-scale-preset]") : null;
        if (!btn) return;
        var preset = btn.getAttribute("data-scale-preset");
        if (preset === "fit") {
          if (api.fitPetScale) api.fitPetScale().then(function() { renderManager(appState); });
          return;
        }
        paintScale(Number(preset), true);
      });
    }
    bindHotkeySettings(state);
    bindChatSettings(state);
    bindOverlaySettings(state);
    var showBackground = document.getElementById("show-background");
    if (showBackground) {
      showBackground.checked = state.config.showBackground === true;
      showBackground.addEventListener("change", function() {
        api.setConfig({ showBackground: showBackground.checked });
      });
    }
    if (sfwEnabled) {
      const sfwInfo = state.sfw || {};
      sfwEnabled.checked = Boolean(sfwInfo.sfw);
      if (sfwInfo.forced === true || sfwInfo.forced === false) {
        sfwEnabled.disabled = true;
        sfwEnabled.title = "本次运行由启动参数强制，修改将在下次启动生效";
      }
    }

    document.getElementById("import-model").addEventListener("click", async () => {
      appState = await api.importModelDirectory();
      renderManager(appState);
    });
    // 63 模型库：重新扫描 / 搜索 / 格式筛选
    var rescanBtn = document.getElementById("rescan-models");
    if (rescanBtn) {
      rescanBtn.addEventListener("click", async function () {
        rescanBtn.disabled = true;
        rescanBtn.textContent = "扫描中…";
        try {
          var result = await api.rescanModels();
          appState = (result && result.state) || (await api.getState());
        } catch (error) {
          appState = (appState && appState.models) ? appState : (await api.getState());
        }
        renderManager(appState);
      });
    }
    var modelSearch = document.getElementById("model-search");
    if (modelSearch) {
      modelSearch.value = managerModelQuery;
      modelSearch.addEventListener("input", function () {
        managerModelQuery = modelSearch.value || "";
        renderModelList(appState);
      });
    }
    var modelKindFilter = document.getElementById("model-kind-filter");
    if (modelKindFilter) {
      modelKindFilter.value = managerModelKind;
      modelKindFilter.addEventListener("change", function () {
        managerModelKind = modelKindFilter.value || "all";
        renderModelList(appState);
      });
    }
    var openGeneratedBtn = document.getElementById("open-generated-scenes");
    if (openGeneratedBtn) openGeneratedBtn.addEventListener("click", () => api.openGeneratedScenes());
    var openDisplayBtn = document.getElementById("open-model-display");
    if (openDisplayBtn) openDisplayBtn.addEventListener("click", () => api.openModelDisplayConfig());
    document.getElementById("open-models").addEventListener("click", () => api.openModelsDirectory());
    document.getElementById("show-pet").addEventListener("click", () => api.showPet());
    document.getElementById("hide-pet").addEventListener("click", () => api.hidePet());
    alwaysOnTop.addEventListener("change", () => api.setConfig({ alwaysOnTop: alwaysOnTop.checked }));
    opacity.addEventListener("input", () => api.setConfig({ opacity: Number(opacity.value) }));
    soundEnabled.addEventListener("change", () => api.setConfig({ soundEnabled: soundEnabled.checked }));
    if (sfwEnabled) {
      sfwEnabled.addEventListener("change", () => api.setConfig({ nsfwMode: !sfwEnabled.checked }));
    }
    // 允许 AI 控制桌宠缩放（默认关闭；开启后 ai-control 才会生成 set_scale 工具）
    var aiScaleEnabled = document.getElementById("ai-scale-enabled");
    if (aiScaleEnabled) {
      aiScaleEnabled.checked = Boolean(state.config.aiControl && state.config.aiControl.scaleEnabled === true);
      aiScaleEnabled.addEventListener("change", () => {
        api.setConfig({ aiControl: { scaleEnabled: aiScaleEnabled.checked } }).then(function (next) {
          appState = next || appState;
        });
      });
    }
    statusUrl.addEventListener("change", () => api.setConfig({ statusPollUrl: statusUrl.value.trim() }));

    function collectTavernConfig() {
      var modelSelect = document.getElementById("tavern-text-model");
      var customModel = document.getElementById("tavern-custom-model");
      var voiceSelect = document.getElementById("tavern-voice");
      var customVoice = document.getElementById("tavern-custom-voice");
      var model = modelSelect && modelSelect.value === "custom" ? (customModel.value.trim() || "deepseek-chat") : modelSelect.value;
      var voice = voiceSelect && voiceSelect.value === "custom" ? (customVoice.value.trim() || "zh_female_tianmeitaozi_uranus_bigtts") : voiceSelect.value;
      return {
        textBaseUrl: document.getElementById("tavern-text-base-url").value.trim(),
        textApiKey: document.getElementById("tavern-text-api-key").value.trim(),
        textModel: model,
        textMaxTokens: Number(document.getElementById("tavern-max-tokens").value || 160),
        textTemperature: Number(document.getElementById("tavern-temperature").value || 0.8),
        rolePrompt: document.getElementById("tavern-role-prompt").value.trim(),
        ttsAppId: document.getElementById("tavern-tts-appid").value.trim(),
        ttsToken: document.getElementById("tavern-tts-token").value.trim(),
        voice: voice,
        ttsSpeed: Number(document.getElementById("tavern-tts-speed").value || 1),
        ttsCluster: "volcano_tts"
      };
    }

    async function saveTavernConfig() {
      appState = await api.setConfig({ tavern: collectTavernConfig() });
    }

    var tavernInputs = document.querySelectorAll("#tavern-text-base-url,#tavern-text-api-key,#tavern-text-model,#tavern-custom-model,#tavern-max-tokens,#tavern-temperature,#tavern-role-prompt,#tavern-tts-appid,#tavern-tts-token,#tavern-voice,#tavern-custom-voice,#tavern-tts-speed");
    for (var ti = 0; ti < tavernInputs.length; ti++) {
      tavernInputs[ti].addEventListener("change", saveTavernConfig);
    }

    // ---- 角色与角色卡：每个角色一张提示词，切换角色分别编辑 ----
    var characterSelect = document.getElementById("character-select");
    if (characterSelect) {
      characterSelect.addEventListener("change", function () {
        managerCharacterId = characterSelect.value || "";
        managerCharacterStatus = "";
        renderManager(appState);
      });
    }
    var characterPrompt = document.getElementById("character-prompt");
    var characterSave = document.getElementById("character-save");
    var characterReset = document.getElementById("character-reset");
    var characterStatus = document.getElementById("character-save-status");
    function currentCharacterId() {
      return characterPrompt ? (characterPrompt.dataset.characterId || managerCharacterId) : managerCharacterId;
    }
    function saveCharacterCard() {
      var id = currentCharacterId();
      if (!id || !characterPrompt) return;
      api.setCharacterPrompt(id, characterPrompt.value).then(function (res) {
        if (res && res.ok) {
          appState = Object.assign({}, appState, { characters: res.characters });
          managerCharacterStatus = "已保存 · " + new Date().toLocaleTimeString();
        } else {
          managerCharacterStatus = "保存失败：" + ((res && res.error) || "unknown");
        }
        if (characterStatus) characterStatus.textContent = managerCharacterStatus;
      }).catch(function (error) {
        managerCharacterStatus = "保存失败：" + (error && error.message ? error.message : error);
        if (characterStatus) characterStatus.textContent = managerCharacterStatus;
      });
    }
    if (characterPrompt) characterPrompt.addEventListener("change", saveCharacterCard);
    if (characterSave) characterSave.addEventListener("click", saveCharacterCard);
    if (characterReset) {
      characterReset.addEventListener("click", function () {
        var id = currentCharacterId();
        if (!id) return;
        api.resetCharacterPrompt(id).then(function (res) {
          if (res && res.ok) {
            appState = Object.assign({}, appState, { characters: res.characters });
            managerCharacterStatus = "已恢复内置角色卡";
          } else {
            managerCharacterStatus = "恢复失败：" + ((res && res.error) || "unknown");
          }
          renderManager(appState);
        });
      });
    }
    var characterModelButtons = document.querySelectorAll("[data-use-character-model]");
    for (var cmi = 0; cmi < characterModelButtons.length; cmi++) {
      characterModelButtons[cmi].addEventListener("click", async function () {
        var modelId = this.dataset.useCharacterModel;
        var next = await api.selectModel(modelId);
        if (next && next.selectError) {
          managerSelectError = next.selectError.message || "该模型当前不可用";
          appState = next;
        } else {
          managerSelectError = "";
          appState = next;
          managerCharacterId = "";
        }
        renderManager(appState);
      });
    }

    // Sound action selects
    var soundSelects = document.querySelectorAll("[data-sound-action]");
    soundSelects.forEach(function(select) {
      var actionId = select.dataset.soundAction;
      var selectedSound = (state.config.soundActions && state.config.soundActions[actionId]) || "random";
      var hasSound = selectedSound === "random" || selectedSound === "none" || (state.selectedSounds || []).some(function(s) { return s.id === selectedSound; });
      select.value = hasSound ? selectedSound : "random";
      select.addEventListener("change", async function() {
        var patch = {};
        patch[actionId] = select.value;
        var soundActions = Object.assign({}, appState.config.soundActions || {}, patch);
        appState = await api.setConfig({ soundActions: soundActions });
        renderManager(appState);
      });
    });

    // Sound preview buttons
    var previewBtns = document.querySelectorAll("[data-preview-sound]");
    for (var pi = 0; pi < previewBtns.length; pi++) {
      previewBtns[pi].addEventListener("click", function() {
        tryPlayModelSound(this.dataset.previewSound, true);
      });
    }

    // Open sounds directory
    var openSoundsBtn = document.getElementById("open-sounds-dir");
    if (openSoundsBtn) {
      openSoundsBtn.addEventListener("click", async function() {
        appState = await api.openSoundsDirectory();
        renderManager(appState);
      });
    }

    // Track SELECT dropdown state: block re-renders while open
    var managerSelects = document.querySelectorAll("[data-sound-action],#tavern-text-model,#tavern-voice");
    for (var msi = 0; msi < managerSelects.length; msi++) {
      managerSelects[msi].addEventListener("focus", function() {
        suppressManagerRender = true;
      });
      managerSelects[msi].addEventListener("blur", function() {
        suppressManagerRender = false;
        if (pendingManagerState) {
          var s = pendingManagerState;
          pendingManagerState = null;
          appState = s;
          renderManager(s);
        }
      });
      managerSelects[msi].addEventListener("change", function() {
        // change fires before blur - release suppression so handler's own renderManager can run
        suppressManagerRender = false;
      });
    }

    renderModelList(state);

  }

  function renderModelList(state) {
    const list = document.getElementById("model-list");
    if (!list) return;
    list.textContent = "";
    const models = (state && state.models) || [];

    // 统计行：63 模型 / C2 / C3 + 排除的文件夹3
    var statsEl = document.getElementById("model-stats");
    var c2 = models.filter(function (model) { return model.kind === "cubism2"; }).length;
    var c3 = models.filter(function (model) { return model.kind !== "cubism2"; }).length;
    if (statsEl) statsEl.textContent = "（" + models.length + " 个：C2 " + c2 + " / C3 " + c3 + "）";
    var statusEl = document.getElementById("model-scan-status");
    if (statusEl) {
      var info = state && state.libraryInfo;
      var parts = [];
      if (info && info.stats) {
        parts.push("模型库扫描：" + info.stats.total + " 个模型（C2 " + info.stats.cubism2 + " / C3 " + info.stats.cubism3 + "）");
        parts.push("自动生成场景：" + info.stats.generatedScenes + " 个模型");
        if (info.displayOverridesFound) parts.push("显示/隐藏部件覆盖：" + info.displayOverridesFound + " 个模型");
      }
      if (info && info.excluded && info.excluded.length) {
        info.excluded.forEach(function (item) {
          parts.push(item.label + " 已排除：" + item.reason);
        });
      }
      if (info && info.issues && info.issues.length) parts.push("扫描警告：" + info.issues.length + " 条");
      if (managerSelectError) parts.push("⚠ " + managerSelectError);
      statusEl.textContent = parts.join(" · ");
    }

    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "model-row";
      empty.textContent = "还没有模型。点击「重新扫描模型库」扫描 1_FFhouse / 2_Tyrano，或导入包含 .model.json / .model3.json 的目录。";
      list.appendChild(empty);
      return;
    }

    // 筛选：搜索 + 格式
    const query = String(managerModelQuery || "").trim().toLowerCase();
    const kindFilter = managerModelKind || "all";
    const filtered = models.filter(function (model) {
      if (kindFilter !== "all" && (model.kind || "cubism3+") !== kindFilter) return false;
      if (!query) return true;
      const haystack = [model.name, model.displayName, model.game, model.modelDirName, model.bundleLabel, model.modelPath]
        .filter(Boolean).join(" ").toLowerCase();
      return haystack.indexOf(query) !== -1;
    });

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "model-row";
      empty.textContent = "没有匹配的模型（搜索：" + managerModelQuery + "，格式：" + kindFilter + "）。";
      list.appendChild(empty);
      return;
    }

    // 分组：文件夹（模型库）→ 游戏 → 模型；手工导入的模型单独成组
    const bundleGroups = new Map();
    for (const model of filtered) {
      const bundleLabel = model.bundleLabel || "手工导入 / 其他";
      if (!bundleGroups.has(bundleLabel)) bundleGroups.set(bundleLabel, new Map());
      const games = bundleGroups.get(bundleLabel);
      const gameLabel = model.game || (model.source === "library" ? "（未分组）" : "手工导入");
      if (!games.has(gameLabel)) games.set(gameLabel, []);
      games.get(gameLabel).push(model);
    }

    const selectedId = state.config && state.config.selectedModelId;
    const fragment = document.createDocumentFragment();

    for (const [bundleLabel, games] of bundleGroups) {
      const bundleBox = document.createElement("div");
      bundleBox.className = "model-group";
      let bundleCount = 0;
      for (const list2 of games.values()) bundleCount += list2.length;
      const bundleHead = document.createElement("h3");
      bundleHead.className = "model-group-title";
      bundleHead.textContent = bundleLabel;
      const countPill = document.createElement("span");
      countPill.className = "muted";
      countPill.textContent = " " + bundleCount;
      bundleHead.appendChild(countPill);
      bundleBox.appendChild(bundleHead);

      for (const [gameLabel, gameModels] of games) {
        const gameBox = document.createElement("div");
        gameBox.className = "model-game";
        const gameHead = document.createElement("h4");
        gameHead.className = "model-game-title";
        gameHead.textContent = gameLabel + "（" + gameModels.length + "）";
        gameBox.appendChild(gameHead);

        for (const model of gameModels) {
          const row = document.createElement("div");
          row.className = "model-row" + (model.id === selectedId ? " selected" : "");

          const info = document.createElement("div");
          info.className = "model-info";
          const title = document.createElement("div");
          title.className = "model-title";
          title.textContent = model.name || model.displayName || model.id;
          // 角色徽章：显示该模型属于哪个角色（角色 → 模型 → 场景 → 动作）
          var characterEntry = characterForModelState(model);
          if (characterEntry) {
            var characterPill = document.createElement("span");
            characterPill.className = "pill kind-char";
            characterPill.textContent = "角色：" + characterEntry.name;
            characterPill.title = "该模型使用「" + characterEntry.name + "」的角色卡提示词";
            title.appendChild(characterPill);
          }
          const pill = document.createElement("span");
          pill.className = "pill" + (model.kind === "cubism2" ? " kind-c2" : " kind-c3");
          pill.textContent = model.kind === "cubism2" ? "C2" : "C3";
          title.appendChild(pill);
          // 场景目录徽章：辅助剖面（非人物）/ NSFW 限定 / 全屏 CG 场景
          var catalogEntry = catalogEntryForModel(model);
          if (catalogEntry && catalogEntry.kind === "auxiliary") {
            var auxPill = document.createElement("span");
            auxPill.className = "pill kind-aux";
            auxPill.textContent = "辅助·剖面（非人物）";
            title.appendChild(auxPill);
          }
          if (catalogEntry && catalogEntry.nsfwOnly) {
            var nsfwPill = document.createElement("span");
            nsfwPill.className = "pill kind-nsfw";
            nsfwPill.textContent = "NSFW限定";
            title.appendChild(nsfwPill);
          }
          if (catalogEntry && catalogEntry.opaqueFullFrame) {
            var cgPill = document.createElement("span");
            cgPill.className = "pill kind-cg";
            cgPill.textContent = "全屏CG场景";
            title.appendChild(cgPill);
          }
          if (model.motionCount) {
            const motionPill = document.createElement("span");
            motionPill.className = "pill";
            motionPill.textContent = model.motionCount + " 动作";
            title.appendChild(motionPill);
          }
          if (model.linkCount) {
            const soundPill = document.createElement("span");
            soundPill.className = "pill";
            soundPill.textContent = model.linkCount + " 原声";
            title.appendChild(soundPill);
          }
          const detail = document.createElement("div");
          detail.className = "muted model-path";
          detail.textContent = (model.game ? model.game + " · " : "") + (model.modelPath || "");
          info.appendChild(title);
          info.appendChild(detail);

          const action = document.createElement("button");
          const selected = selectedId === model.id;
          const auxiliaryBlocked = Boolean(catalogEntry && catalogEntry.kind === "auxiliary" && state.sfw && state.sfw.sfw);
          action.textContent = selected ? "使用中" : (auxiliaryBlocked ? "需先开 NSFW" : "使用");
          action.disabled = selected || auxiliaryBlocked;
          action.className = selected || auxiliaryBlocked ? "" : "primary";
          if (auxiliaryBlocked) {
            action.title = "辅助视角模型（非人物立绘）只应在 NSFW 开启后按需启用";
          }
          action.addEventListener("click", async () => {
            var next = await api.selectModel(model.id);
            if (next && next.selectError) {
              managerSelectError = next.selectError.message || "该模型当前不可用";
              appState = next;
            } else {
              managerSelectError = "";
              appState = next;
              // 切换模型后角色卡编辑器跟随当前模型所属角色
              managerCharacterId = "";
              managerCharacterStatus = "";
            }
            renderManager(appState);
          });

          row.appendChild(info);
          row.appendChild(action);
          gameBox.appendChild(row);
        }
        bundleBox.appendChild(gameBox);
      }
      fragment.appendChild(bundleBox);
    }
    list.appendChild(fragment);
  }

  // 桌宠改造：未配置聊天 API Key 时隐藏底部聊天条，让桌宠画面更干净（配置 Key 后自动显示）
  function syncTavernBarVisibility() {
    var bar = document.getElementById("tavern-bar");
    if (!bar) return;
    var tavern = (appState && appState.config && appState.config.tavern) || {};
    bar.style.display = tavern.textApiKey ? "" : "none";
    // 聊天框占位文字跟随当前角色（角色 → 模型映射由主进程下发）
    var input = document.getElementById("tavern-input");
    var chars = (appState && appState.characters) || {};
    var active = chars.activeCharacter;
    if (input) {
      input.placeholder = active && active.name ? "和" + active.name + "聊天..." : "和呆呆聊天...";
    }
    // 角色切换 = 换了一张角色卡：清空聊天上下文，聊天记录按角色隔离重载
    var activeCharacterId = chars.activeCharacterId || "";
    var characterSwitched = Boolean(tavernCharacterId) && activeCharacterId !== tavernCharacterId;
    tavernCharacterId = activeCharacterId;
    if (characterSwitched) {
      tavernHistory = [];
      clearChatBubbles();
      chatHistoryEntries = [];
      if (chatPanelOpen) reloadChatHistory();
      if (active && active.name) showSceneToast("角色已切换：" + active.name, "character", 2600);
    }
  }

  // ==============================
  // 聊天悬浮层：文字气泡贴在模型头顶；气泡/输入条/聊天记录面板可自由拖动，
  // 位置按 pet-stage 百分比保存（窗口缩放后相对位置不变）。配置来自 config.overlay。
  // ==============================
  // 兜底默认值：与 src/main/config-store.js 的 DEFAULT_OVERLAY 保持一致（老主进程/旧配置缺字段时用）
  var OVERLAY_DEFAULTS = {
    locked: false,
    bubble: { mode: "follow", x: 50, y: 18, width: 78 },
    input: { x: 50, y: 92, width: 72 },
    panel: { x: 78, y: 50, width: 84, height: 88 }
  };

  function overlayNumber(value, fallback, min, max) {
    var num = value === null || value === undefined || value === "" ? NaN : Number(value);
    if (!isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  // 读取并归一化当前 overlay 配置（老配置缺字段/越界值时回落到默认）
  function overlayConfig() {
    var raw = (appState && appState.config && appState.config.overlay) || {};
    var bubble = raw.bubble || {};
    var input = raw.input || {};
    var panel = raw.panel || {};
    return {
      locked: raw.locked === true,
      bubble: {
        mode: bubble.mode === "manual" ? "manual" : "follow",
        x: overlayNumber(bubble.x, OVERLAY_DEFAULTS.bubble.x, 0, 100),
        y: overlayNumber(bubble.y, OVERLAY_DEFAULTS.bubble.y, 0, 100),
        width: overlayNumber(bubble.width, OVERLAY_DEFAULTS.bubble.width, 25, 96)
      },
      input: {
        x: overlayNumber(input.x, OVERLAY_DEFAULTS.input.x, 0, 100),
        y: overlayNumber(input.y, OVERLAY_DEFAULTS.input.y, 0, 100),
        width: overlayNumber(input.width, OVERLAY_DEFAULTS.input.width, 25, 96)
      },
      panel: {
        x: overlayNumber(panel.x, OVERLAY_DEFAULTS.panel.x, 0, 100),
        y: overlayNumber(panel.y, OVERLAY_DEFAULTS.panel.y, 0, 100),
        width: overlayNumber(panel.width, OVERLAY_DEFAULTS.panel.width, 25, 96),
        height: overlayNumber(panel.height, OVERLAY_DEFAULTS.panel.height, 35, 96)
      }
    };
  }

  function overlayStageSize(stage) {
    return {
      width: Math.max(1, (stage && stage.clientWidth) || window.innerWidth || 1),
      height: Math.max(1, (stage && stage.clientHeight) || window.innerHeight || 1)
    };
  }

  // 把元素中心点限制在窗口内（留 margin），元素比窗口还大时直接居中
  function clampOverlayCenter(value, size, stageSize, margin) {
    var half = Math.min(size / 2, stageSize / 2 - 1);
    var min = half + margin;
    var max = stageSize - half - margin;
    if (max <= min) return stageSize / 2;
    return Math.min(max, Math.max(min, value));
  }

  function overlayPercent(value) {
    return Math.round(value * 100) / 100;
  }

  // 气泡 follow 锚点：模型实际绘制内容的顶部中点（不盖住模型）。
  // 优先用像素包围盒（对 C2/C3 都准确，只在布局事件时读一次）；失败时兜底 canvas bounds。
  // forceMeasure=true（模型加载/窗口 resize/场景切换）时重新测量，其余情况复用短缓存。
  function bubbleFollowAnchor(stageSize, forceMeasure) {
    if (!live2dModel) return null;
    var art = null;
    var cache = overlayArtCache;
    var cacheValid = !forceMeasure && cache && cache.modelId === loadedModelId &&
      cache.width === stageSize.width && cache.height === stageSize.height &&
      Date.now() - cache.at < 15000;
    if (cacheValid) {
      art = cache.art;
    } else {
      try { art = measureScreenArtBounds(); } catch (e) { art = null; }
      if (!art || art.error || !isFinite(art.top) || !isFinite(art.left) || !isFinite(art.right)) {
        art = null;
        try {
          var bounds = live2dModel.getBounds();
          if (bounds && isFinite(bounds.x) && isFinite(bounds.y)) {
            art = {
              left: bounds.x,
              top: bounds.y,
              right: bounds.x + Number(bounds.width || 0),
              bottom: bounds.y + Number(bounds.height || 0)
            };
          }
        } catch (e) { art = null; }
      }
      if (art) {
        overlayArtCache = { modelId: loadedModelId, width: stageSize.width, height: stageSize.height, at: Date.now(), art: art };
      }
    }
    if (!art) return null;
    var stack = document.getElementById("chat-bubble-stack");
    var stackW = (stack && stack.offsetWidth) || Math.min(stageSize.width * 0.78, 340);
    var stackH = (stack && stack.offsetHeight) || 40;
    var x = clampOverlayCenter((art.left + art.right) / 2, stackW, stageSize.width, 6);
    // 气泡堆叠底部对齐锚点（transform translate(-50%,-100%)）：顶部不能超出窗口
    var y = Math.min(stageSize.height - 6, Math.max(stackH + 6, art.top - 8));
    return { x: x, y: y, art: art, top: art.top };
  }

  // 把 overlay 配置写进 CSS 变量/元素位置；follow 时按模型头顶锚点定位
  function applyOverlayLayout(forceMeasure) {
    var stage = document.getElementById("pet-stage");
    if (!stage) return;
    var cfg = overlayConfig();
    var size = overlayStageSize(stage);
    var state = { config: cfg, window: size, applied: {}, follow: null };
    // 尺寸类配置写成 CSS 变量（width/height 为百分比）
    stage.style.setProperty("--overlay-bubble-width", cfg.bubble.width + "%");
    stage.style.setProperty("--overlay-input-width", cfg.input.width + "%");
    stage.style.setProperty("--overlay-panel-width", cfg.panel.width + "%");
    stage.style.setProperty("--overlay-panel-height", cfg.panel.height + "%");

    var stack = document.getElementById("chat-bubble-stack");
    if (stack) {
      var follow = cfg.bubble.mode === "follow";
      var anchor = follow ? bubbleFollowAnchor(size, forceMeasure === true) : null;
      var useFollow = Boolean(anchor);
      stack.classList.toggle("overlay-follow", useFollow);
      stack.classList.toggle("overlay-manual", !useFollow);
      if (useFollow) {
        stack.style.left = anchor.x + "px";
        stack.style.top = anchor.y + "px";
        state.applied.bubble = { mode: "follow", x: anchor.x, y: anchor.y, artTop: anchor.art.top };
        state.follow = { x: anchor.x, y: anchor.y, art: anchor.art };
      } else {
        var stackW = stack.offsetWidth || (size.width * cfg.bubble.width) / 100;
        var stackH = stack.offsetHeight || 40;
        var bx = clampOverlayCenter((cfg.bubble.x / 100) * size.width, stackW, size.width, 6);
        var by = clampOverlayCenter((cfg.bubble.y / 100) * size.height, stackH, size.height, 6);
        stack.style.left = bx + "px";
        stack.style.top = by + "px";
        state.applied.bubble = { mode: cfg.bubble.mode, x: bx, y: by };
      }
    }

    var bar = document.getElementById("tavern-bar");
    if (bar) {
      var barW = bar.offsetWidth || (size.width * cfg.input.width) / 100;
      var barH = bar.offsetHeight || 46;
      var ix = clampOverlayCenter((cfg.input.x / 100) * size.width, barW, size.width, 6);
      var iy = clampOverlayCenter((cfg.input.y / 100) * size.height, barH, size.height, 6);
      bar.style.left = ix + "px";
      bar.style.top = iy + "px";
      state.applied.input = { x: ix, y: iy };
    }

    var panel = document.getElementById("chat-panel");
    if (panel) {
      var panelW = panel.offsetWidth || (size.width * cfg.panel.width) / 100;
      var panelH = panel.offsetHeight || (size.height * cfg.panel.height) / 100;
      var px = clampOverlayCenter((cfg.panel.x / 100) * size.width, panelW, size.width, 4);
      var py = clampOverlayCenter((cfg.panel.y / 100) * size.height, panelH, size.height, 4);
      panel.style.left = px + "px";
      panel.style.top = py + "px";
      state.applied.panel = { x: px, y: py };
    }
    // 自动化/排障快照（只读）：配置 + 实际像素位置 + follow 锚点
    window.__petOverlayState = state;
  }

  // 节流刷新：模型加载/窗口 resize/场景切换/配置更新时调用，避免每帧测量像素包围盒。
  // forceMeasure=true 时丢弃 follow 锚点缓存重新测量（fit/resize/场景切换）。
  function scheduleOverlayLayout(delay, forceMeasure) {
    if (forceMeasure) overlayLayoutForce = true;
    if (overlayLayoutTimer) return;
    overlayLayoutTimer = setTimeout(function () {
      overlayLayoutTimer = null;
      var force = overlayLayoutForce;
      overlayLayoutForce = false;
      try { applyOverlayLayout(force); } catch (e) {}
    }, delay === undefined ? 200 : Math.max(0, delay));
  }

  // 保存悬浮层位置：必须提交完整 overlay 对象（api.setConfig 是浅合并，只传子对象会丢字段）
  function saveOverlayPosition(kind, pctX, pctY) {
    var cfg = overlayConfig();
    if (kind === "bubble") {
      cfg.bubble.mode = "manual";
      cfg.bubble.x = pctX;
      cfg.bubble.y = pctY;
    } else if (kind === "input") {
      cfg.input.x = pctX;
      cfg.input.y = pctY;
    } else if (kind === "panel") {
      cfg.panel.x = pctX;
      cfg.panel.y = pctY;
    }
    if (!api || !api.setConfig) return;
    api.setConfig({ overlay: cfg }).then(function (next) {
      if (next) appState = next;
    }, function () {});
  }

  // 拖动气泡/输入条/记录面板：pointer 事件 + 4px 阈值 + 边界 clamp + 拖动结束按百分比保存
  function bindOverlayDrag() {
    var stage = document.getElementById("pet-stage");
    if (!stage) return;

    function centerOf(el) {
      var stageRect = stage.getBoundingClientRect();
      var rect = el.getBoundingClientRect();
      return {
        x: rect.left - stageRect.left + rect.width / 2,
        y: rect.top - stageRect.top + rect.height / 2,
        width: rect.width,
        height: rect.height
      };
    }

    function begin(event, el, kind) {
      if (overlayDrag || event.button !== 0) return;
      var cfg = overlayConfig();
      if (cfg.locked) return;
      var center = centerOf(el);
      overlayDrag = {
        el: el,
        kind: kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        centerX: center.x,
        centerY: center.y,
        width: center.width,
        height: center.height,
        size: overlayStageSize(stage),
        moved: false,
        lastX: center.x,
        lastY: center.y
      };
      // 用 document 级监听跟随拖动（不 setPointerCapture，避免影响气泡的普通 click 打开聊天面板）
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", end);
      // follow 气泡被拖动：先按当前视觉中心切到 manual 定位，避免切换 transform 时跳一下
      if (el.classList.contains("overlay-follow")) {
        el.classList.remove("overlay-follow");
        el.classList.add("overlay-manual");
        el.style.left = center.x + "px";
        el.style.top = center.y + "px";
      }
    }

    function move(event) {
      var drag = overlayDrag;
      if (!drag) return;
      if (event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) <= 4) return;
        drag.moved = true;
        drag.el.classList.add("dragging");
        document.body.classList.add("overlay-dragging");
      }
      event.preventDefault();
      var x = clampOverlayCenter(drag.centerX + dx, drag.width, drag.size.width, 6);
      var y = clampOverlayCenter(drag.centerY + dy, drag.height, drag.size.height, 6);
      drag.el.style.left = x + "px";
      drag.el.style.top = y + "px";
      drag.lastX = x;
      drag.lastY = y;
    }

    function end() {
      var drag = overlayDrag;
      overlayDrag = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      if (!drag) return;
      drag.el.classList.remove("dragging");
      document.body.classList.remove("overlay-dragging");
      if (!drag.moved) return; // 未拖动：保留原 click 行为（气泡点击打开聊天面板）
      overlaySuppressClickUntil = Date.now() + 350;
      var pctX = overlayPercent(Math.min(100, Math.max(0, (drag.lastX / drag.size.width) * 100)));
      var pctY = overlayPercent(Math.min(100, Math.max(0, (drag.lastY / drag.size.height) * 100)));
      saveOverlayPosition(drag.kind, pctX, pctY);
    }

    var stack = document.getElementById("chat-bubble-stack");
    if (stack) {
      stack.addEventListener("pointerdown", function (event) {
        if (event.target && event.target.closest && event.target.closest("input,button,textarea,select,a")) return;
        begin(event, stack, "bubble");
      });
    }

    var bar = document.getElementById("tavern-bar");
    if (bar) {
      // 输入条只允许按 ⠿ 把手拖动，避免误触输入框
      bar.addEventListener("pointerdown", function (event) {
        var grip = event.target && event.target.closest ? event.target.closest(".overlay-grip") : null;
        if (!grip) return;
        begin(event, bar, "input");
      });
    }

    var panel = document.getElementById("chat-panel");
    if (panel) {
      // 聊天记录面板只允许拖动标题栏空白处（按钮不触发）
      panel.addEventListener("pointerdown", function (event) {
        var head = event.target && event.target.closest ? event.target.closest(".chat-panel-head") : null;
        if (!head) return;
        if (event.target.closest && event.target.closest("button")) return;
        begin(event, panel, "panel");
      });
    }

    bindOverlayStackObserver();
  }

  // 气泡堆叠高度会随气泡数量/打字机文字增长：follow 模式下面板/气泡若顶出窗口，
  // 需要用新的高度重新夹紧锚点。ResizeObserver 只在尺寸变化时触发，节流后重新布局。
  var overlayStackObserver = null;
  function bindOverlayStackObserver() {
    var stack = document.getElementById("chat-bubble-stack");
    if (!stack || typeof ResizeObserver !== "function") return;
    if (overlayStackObserver) {
      try { overlayStackObserver.disconnect(); } catch (e) {}
    }
    overlayStackObserver = new ResizeObserver(function () {
      scheduleOverlayLayout(60, false);
    });
    overlayStackObserver.observe(stack);
  }

  // 当前桌宠缩放百分比（AI 能力清单用）：优先实际生效值，其次配置值
  function currentPetScalePercent() {
    var state = appState || {};
    var applied = state.petScale && state.petScale.scale;
    var base = state.config && state.config.petScale;
    var scale = Number(applied || base || 1) || 1;
    return Math.min(200, Math.max(25, Math.round(scale * 100)));
  }

  function renderPetShell() {
    document.body.className = "pet-body";
    root.innerHTML = `        <audio id="tavern-audio" style="display:none"></audio>
      <div class="pet-stage" id="pet-stage">
        <canvas id="live2d-canvas"></canvas>
        <div class="sfw-overlay" id="sfw-overlay" aria-hidden="true"></div>
        <div class="scene-toast" id="scene-toast" aria-live="polite"></div>
        <div class="empty-pet" id="empty-pet">
          <div>
            <strong id="empty-title">还没有选择 Live2D 模型</strong>
            <span id="empty-desc">从托盘打开管理，导入模型目录后就能显示。</span>
          </div>
        </div>
        <div class="bubble-stack">
          <div class="agent-bubble" id="bubble-codex">
            <div class="bubble-head"><span class="dot" id="dot-codex"></span><span class="bubble-title" id="title-codex"></span></div>
            <div class="bubble-text" id="text-codex"></div>
          </div>
          <div class="agent-bubble" id="bubble-claude">
            <div class="bubble-head"><span class="dot" id="dot-claude"></span><span class="bubble-title" id="title-claude"></span></div>
            <div class="bubble-text" id="text-claude"></div>
          </div>
        </div>
        <div class="chat-bubble-stack" id="chat-bubble-stack" aria-live="polite"></div>
        <aside class="chat-panel" id="chat-panel" aria-hidden="true">
          <header class="chat-panel-head">
            <strong id="chat-panel-title">聊天记录</strong>
            <span class="chat-panel-count" id="chat-panel-count"></span>
            <button type="button" id="chat-panel-close" title="关闭面板">✕</button>
          </header>
          <div class="chat-panel-list" id="chat-panel-list"></div>
          <footer class="chat-panel-foot">
            <span class="muted" id="chat-panel-hint"></span>
            <button type="button" id="chat-panel-clear">清空</button>
          </footer>
        </aside>
        <div class="tavern-bar" id="tavern-bar">
          <span class="overlay-grip" id="tavern-bar-grip" title="拖动输入框" aria-label="拖动输入框">⠿</span>
          <input type="text" id="tavern-input" placeholder="和呆呆聊天..." maxlength="200" />
          <button id="tavern-send">↵</button>
        </div>
      </div>
    `;
  }

  // 桌宠改造：按配置隐藏模型里的“背景部件”（Tyrano 模型把游戏场景背景也做进了 moc，
  // 不隐藏的话桌宠会显示成一个带背景的矩形画面）。
  // 63 模型兼容：hiddenParts 同时支持 Cubism2 部件索引与 Cubism3/4 部件 id，
  // 来源 = scenes.generated.json（model-display.json 探测结果） + config.hiddenParts（手工覆盖）。
  function applyHiddenParts(modelId) {
    hiddenPartState = resolveHiddenParts(modelId);
    hiddenDrawableState = resolveHiddenDrawables(modelId);
    applyPartOverridesNow();
    return { parts: hiddenPartState.slice(), drawables: hiddenDrawableState.slice() };
  }

  function loadModelSettings(url) {
    // Use fetch for file:// URLs (external models), XHR for relative paths
    var isFile = typeof url === "string" && url.startsWith("file://");
    if (isFile) {
      return fetch(url).then(function(r) {
        if (!r.ok) throw new Error("fetch failed: " + r.status);
        return r.json().then(function(settings) {
          settings.url = url;
          return settings;
        });
      });
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.overrideMimeType("application/json");
      xhr.onload = () => {
        if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
          reject(new Error(`加载模型配置失败: ${xhr.status} ${url}`));
          return;
        }

        try {
          const settings = JSON.parse(xhr.responseText);
          settings.url = url;
          resolve(settings);
        } catch (error) {
          reject(new Error(`模型配置不是有效 JSON: ${url}; ${error.message || error}`));
        }
      };
      xhr.onerror = () => reject(new Error(`加载模型配置失败: ${url}`));
      xhr.send();
    });
  }

  // 桌宠缩放修复（task-14）：Electron 主进程 setBounds 改窗口尺寸后，PIXI 渲染器内部画布
  // 仍是 Application 创建时的旧尺寸（screen 1000×816），而 canvas 元素被 CSS 拉伸/裁切到新窗口，
  // 于是 50% 时模型被排到可视区外、放大时只是把旧画布裁切放大。
  // 这里在每次 fit 前把 renderer 同步到「当前窗口 CSS 尺寸」（autoDensity 下会按 devicePixelRatio
  // 重建后备缓冲并设置 canvas 的 CSS 宽高），保证模型按真实窗口重新排版、不裁切、无白边。
  function syncLive2dRendererSize() {
    if (!live2dApp || !live2dApp.renderer) return null;
    // 用未取整的 innerWidth/innerHeight：Windows 125% DPI 下窗口 CSS 尺寸可能是 702.4 这类小数，
    // PIXI renderer.resize 支持小数（canvas CSS 尺寸按小数、后备缓冲按 devicePixelRatio 取整）。
    var w = Math.max(1, Number(window.innerWidth) || Number(document.documentElement.clientWidth) || 1);
    var h = Math.max(1, Number(window.innerHeight) || Number(document.documentElement.clientHeight) || 1);
    try {
      var renderer = live2dApp.renderer;
      var dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
      var currentRes = Number(renderer.resolution) || 1;
      var resChanged = Math.abs(currentRes - dpr) > 0.01;
      var screenW = Number(live2dApp.screen && live2dApp.screen.width) || 0;
      var screenH = Number(live2dApp.screen && live2dApp.screen.height) || 0;
      if (resChanged) renderer.resolution = dpr;
      // 尺寸或 DPR 变化时才 resize（避免每帧重建后备缓冲）；resize 会同步 canvas CSS 尺寸
      if (resChanged || Math.abs(screenW - w) > 0.5 || Math.abs(screenH - h) > 0.5) {
        renderer.resize(w, h);
      }
    } catch (e) {}
    return { width: w, height: h };
  }

  function fitLive2dModel() {
    if (!live2dApp || !live2dModel) return;

    // 先同步渲染画布到窗口真实尺寸，再按新尺寸重新 fit（窗口 resize / pet:resize 两条路径都走这里）
    var live2dSize = syncLive2dRendererSize();
    var cw = (live2dSize && live2dSize.width) || live2dApp.screen.width;
    var ch = (live2dSize && live2dSize.height) || live2dApp.screen.height;
    var mw = 1000;
    var mh = 1800;
    try {
      if (live2dModel.internalModel) {
        mw = Number(live2dModel.internalModel.width) || mw;
        mh = Number(live2dModel.internalModel.height) || mh;
      }
    } catch (e) {}
    // 桌宠改造：按模型画布真实尺寸缩放，默认铺满窗口（可用 config.modelScale 微调）
    // 场景系统：scenes.json 里可为单个模型配置 display.scale（如 R01 需要 1.0 才不被裁头）
    // task-14：先按「模型内部画布」适配，再用 drawable 顶点计算的实际绘制内容包围盒
    // （含画到画布外的头发/腿等）做“完整可见”校正；顶点数据不依赖像素读取，稳定可复现，
    // 保证 50%~200% 等比且不裁切。
    var padX = 8;
    var padY = 10;
    var margin = 6; // 实际绘制内容距离窗口边缘的最小留白
    var safety = 1.08; // 余量：换装/动作/呼吸会让内容临时变大
    var fitW = Math.max(1, cw - padX * 2);
    var fitH = Math.max(1, ch - padY * 2);
    var factor = effectiveModelScale();
    live2dModel.anchor.set(0.5, 1);
    var canvasFit = Math.min(fitW / mw, fitH / mh) * factor;

    var fitStartedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    var artUnits = null;
    // C2 模型实际绘制内容尺寸：在「模型加载后的默认姿态」测量一次并缓存，窗口缩放时复用，
    // 保证 50%~200% 六档等比且不裁切；随机动作/换装期间姿态变化可能短暂贴边（动画本身特性）。
    var canUseGeometry = Boolean(live2dModel && live2dModel.internalModel && live2dModel.internalModel.coreModel &&
      typeof live2dModel.internalModel.coreModel.getTransformedPoints === "function");
    if (canUseGeometry) {
      if (artUnitsCache && artUnitsCache.modelId === loadedModelId) {
        artUnits = artUnitsCache.units;
      } else if (pendingArtUnitsMeasure) {
        pendingArtUnitsMeasure = false;
        var measuredUnits = null;
        try { measuredUnits = measureDrawableArtBoundsUnits(); } catch (e) { measuredUnits = null; }
        if (measuredUnits && measuredUnits.width > 100 && measuredUnits.height > 100 &&
            measuredUnits.width <= mw * 1.6 && measuredUnits.height <= mh * 2.2) {
          artUnits = measuredUnits;
          artUnitsCache = { modelId: loadedModelId, units: measuredUnits };
        }
      }
    }

    var finalScale = canvasFit;
    var finalX = cw / 2;
    var finalY = ch - padY;
    var artFit = null;
    var artMetrics = null;
    if (artUnits && artUnits.width > 1 && artUnits.height > 1) {
      // 内容尺寸（模型单位，含安全余量）+ 相对锚点（画布底边中心）的中心/底边偏移
      var wUnits = artUnits.width * safety;
      var hUnits = artUnits.height * safety;
      var centerXUnits = (artUnits.left + artUnits.right) / 2 - mw / 2;
      var bottomUnits = artUnits.bottom - mh;
      artFit = Math.min(
        Math.max(1, cw - margin * 2) / wUnits,
        Math.max(1, ch - margin * 2) / hUnits
      );
      artMetrics = { wUnits: wUnits, hUnits: hUnits, centerXUnits: centerXUnits, bottomUnits: bottomUnits, drawables: artUnits.drawables };
      // 内容比画布大时按内容缩小；内容比画布小时保持画布适配（避免把透明留白也算进去放大）
      finalScale = Math.min(canvasFit, artFit);
      if (finalScale < canvasFit - 0.001) {
        // 兜底：不允许缩得过小（正常 Tyrano 立绘约 0.7~0.9 倍画布适配）
        finalScale = Math.max(finalScale, canvasFit * 0.5);
        finalX = cw / 2 - centerXUnits * finalScale;
        finalY = (ch - margin) - bottomUnits * finalScale;
        var canvasHeight = mh * finalScale;
        finalY = Math.min(ch, Math.max(canvasHeight, finalY));
      }
    }

    live2dModel.scale.set(finalScale);
    live2dModel.position.set(finalX, finalY);
    // 立即刷新 worldTransform，保证 resize 后第一帧就是最终位置
    try {
      if (typeof live2dModel.updateTransform === "function") live2dModel.updateTransform();
    } catch (e) {}
    live2dApp.renderer.render(live2dApp.stage);
    var fitEndedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    // 自检快照：记录本次 fit 的计算过程（自动化断言/排障用）
    lastFitInfo = {
      window: { width: cw, height: ch },
      internal: { width: mw, height: mh },
      canvasFit: canvasFit,
      artUnits: artUnits ? {
        left: artUnits.left, top: artUnits.top, right: artUnits.right, bottom: artUnits.bottom,
        width: artUnits.width, height: artUnits.height, drawables: artUnits.drawables
      } : null,
      artMetrics: artMetrics,
      artFit: artFit,
      finalScale: finalScale,
      finalPosition: [finalX, finalY],
      ms: Math.round((fitEndedAt - fitStartedAt) * 10) / 10,
      at: Date.now()
    };
    // fit 完成后模型包围盒变化：节流刷新悬浮层（气泡 follow 锚点依赖模型实际绘制内容）
    scheduleOverlayLayout(120, true);
  }
  var lastFitInfo = null;
  // C2 实际绘制内容尺寸缓存（模型加载默认姿态测量一次；切模型失效）
  var artUnitsCache = null;
  var pendingArtUnitsMeasure = false;

  function destroyLive2dApp() {
    if (live2dResizeHandler) {
      window.removeEventListener("resize", live2dResizeHandler);
      live2dResizeHandler = null;
    }
    unloadLive2dModel();
    if (live2dApp) {
      live2dApp.destroy(false, { children: true, texture: true, baseTexture: true });
      live2dApp = null;
    }
  }

  // WebGL context 偶发错误（getAttribLocation/WebGLProgram）后，旧 canvas/上下文可能已损坏：
  // 彻底销毁 PIXI 应用并换一块新 canvas，再重试加载模型，避免重试仍命中坏上下文。
  function resetLive2dWebglContext() {
    try {
      destroyLive2dApp();
    } catch (e) {}
    try {
      var oldCanvas = document.getElementById("live2d-canvas");
      if (oldCanvas && oldCanvas.parentNode) {
        var fresh = document.createElement("canvas");
        fresh.id = "live2d-canvas";
        oldCanvas.parentNode.replaceChild(fresh, oldCanvas);
      }
    } catch (e) {}
    _overrideHandlerBound = false;
    hiddenPartState = [];
    hiddenDrawableState = [];
    live2dModel = null;
    loadedModelId = null;
    return true;
  }

  function clearStatusMotion() {
    statusMotionKind = "idle";
    if (statusMotionTimer) {
      clearInterval(statusMotionTimer);
      statusMotionTimer = null;
    }
  }

  function unloadLive2dModel() {
    clearRandomBodyMotion();
    clearSpeakingBodyMotion();
    stopLipSync();
    // 切模型时停止场景并清空换装等参数状态（避免新模型带着上一个模型的服装参数）
    try { stopSceneRuntime({ report: false }); } catch (e) {}
    unbindModelOverrideHandler();
    if (live2dModel) {
      try {
        if (live2dApp && live2dApp.stage) live2dApp.stage.removeChild(live2dModel);
        if (typeof live2dModel.destroy === "function") {
          live2dModel.destroy({ children: true });
        }
      } catch {}
      live2dModel = null;
    }
    loadedModelId = null;
    hiddenPartState = [];
    artUnitsCache = null;
    pendingArtUnitsMeasure = false;
    overlayArtCache = null;
    // 桌宠改造：卸载模型时清空当前模型与关联声音，避免切模型后播错声音
    currentModelRecord = null;
    modelLinks = [];
    clearStatusMotion();
  }

  function ensureLive2dApp(canvas) {
    if (live2dApp) return live2dApp;

    live2dApp = new PIXI.Application({
      view: canvas,
      transparent: true,
      backgroundAlpha: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      autoStart: true
    });

    live2dResizeHandler = fitLive2dModel;
    window.addEventListener("resize", live2dResizeHandler);
    return live2dApp;
  }

  function showLive2dError(title, message) {
    const empty = document.getElementById("empty-pet");
    if (!empty) return;
    empty.style.display = "grid";
    empty.querySelector("strong").textContent = title;
    empty.querySelector("span").textContent = message || "";
  }

  function hideLive2dError() {
    const empty = document.getElementById("empty-pet");
    if (empty) {
      empty.style.display = "none";
    }
  }

  var _loadingModelId = null;
  var _loadToken = 0;
  async function loadLive2dModel(model) {
    if (!model) {
      unloadLive2dModel();
      showLive2dError("还没有选择 Live2D 模型", "从托盘打开管理，选择/导入模型后就能显示。");
      _loadingModelId = null;
      return;
    }
    // 63 模型兼容：Cubism2 与 Cubism3/4 都由 PIXI.live2d.Live2DModel 自动选择运行时
    if (model.kind !== "cubism2" && model.kind !== "cubism3+") {
      unloadLive2dModel();
      showLive2dError("不支持的模型格式", "只支持 Cubism2（.model.json）与 Cubism3/4（.model3.json）。");
      _loadingModelId = null;
      return;
    }
    // 如果同一个模型正在加载中，等待它完成
    if (_loadingModelId === model.id) return;
    // 如果已经加载完成，跳过
    if (loadedModelId === model.id) return;

    _loadingModelId = model.id;
    var loadStartedAt = Date.now();

    if (!window.PIXI || !window.PIXI.live2d || !window.PIXI.live2d.Live2DModel) {
      showLive2dError("Live2D runtime 未加载", "");
      _loadingModelId = null;
      return;
    }
    // 统一由本文件播放原声，避免 C2 运行时内建播放造成双份声音
    try { if (PIXI.live2d.config) PIXI.live2d.config.sound = false; } catch (e) {}

    const canvas = document.getElementById("live2d-canvas");
    const token = ++_loadToken;

    try {
      ensureLive2dApp(canvas);
      unloadLive2dModel();
      var modelUrl = model.modelUrl || model.modelPath.replace(/\\/g, "/");
      var settings = await loadModelSettings(modelUrl);
      var nextModel = await PIXI.live2d.Live2DModel.from(settings);
      if (token !== _loadToken) {
        try {
          nextModel.destroy({ children: true });
        } catch {}
        return;
      }
      live2dModel = nextModel;
      loadedModelId = model.id;
      _loadingModelId = null;
      // 加载成功：清掉上一次失败记录（自动重试成功后不应误报加载失败）
      window.__lastModelLoadError = null;
      // 场景系统：切模型后载入对应模型的场景配置，清空上一个模型的换装/过渡状态
      sceneRuntime.config = (appState && appState.sceneConfig) || sceneRuntime.config;
      sceneRuntime.modelId = model.id;
      sceneRuntime.current = null;
      sceneRuntime.transition = null;
      sceneRuntime.paramState = {};
      sceneRuntime.partState = {};
      _sceneMotionIndex = null;
      window.__sceneMotionIndex = null;
      live2dApp.stage.addChild(live2dModel);
      // Cubism3/4：安装 drawable 透明度钩子（隐藏内嵌背景部件用，必须在 core.update 之后写入）
      try { installC4DrawableHook(live2dModel.internalModel && live2dModel.internalModel.coreModel); } catch (e) {}
      // 先隐藏内嵌背景部件，再 fit —— 否则测量“实际绘制内容”时会把背景也算进去导致模型被缩得过小
      applyHiddenParts(model.id);
      bindModelOverrideHandler();
      applyPartOverridesNow();
      fitLive2dModel();
      // 加载瞬间 core 顶点可能还没更新：标记在 1.4s 后的稳定姿态再测量一次实际绘制内容尺寸
      pendingArtUnitsMeasure = true;
      hideLive2dError();
      updateLive2dMotion(appState && appState.status, true);
      scheduleRandomBodyMotion(3500);
      // 加载完成 1.4s 后按稳定姿态重新 fit 一次（同时缓存 C2 实际绘制内容尺寸）
      setTimeout(function() {
        if (loadedModelId !== model.id) return;
        pendingArtUnitsMeasure = true;
        try { fitLive2dModel(); } catch (e) {}
      }, 1400);
      // 桌宠改造：记录当前模型并异步加载“动作↔原声”关联
      currentModelRecord = model;
      loadModelLinks(model).then(function(links) {
        if (loadedModelId === model.id) modelLinks = links;
      });
      // 上报当前模型能力清单（工具 schema 随模型变化，主进程用它构造 function calling 请求）
      reportAiCapabilities();
      // 场景目录：辅助/剖面模型提示条（3~5s）；全屏 CG 场景提示无法去背
      var catalogEntry = catalogEntryForModel(model);
      setTimeout(function() {
        if (loadedModelId !== model.id) return;
        if (catalogEntry && catalogEntry.kind === "auxiliary") {
          showSceneToast("辅助视角模型（非人物立绘）", "aux", 4200);
        } else if (catalogEntry && catalogEntry.opaqueFullFrame) {
          showSceneToast("全屏 CG 场景（含背景，无法去背）", "aux", 3200);
        }
      }, 720);
      // 场景目录切换：模型加载完成后执行目标场景
      if (pendingCatalogScene && pendingCatalogScene.modelId === model.id) {
        var sceneToPlay = pendingCatalogScene.sceneId || "idle";
        pendingCatalogScene = null;
        setTimeout(function() {
          if (loadedModelId === model.id) executeScene(sceneToPlay, { source: "catalog", force: true });
        }, 950);
      }
      // 自动化自检：记录本次模型加载耗时/尺寸/动作组数
      try {
        var defs = motionDefinitions();
        var groups = Object.keys(defs);
        window.__lastModelLoad = {
          id: model.id,
          name: model.name,
          kind: model.kind,
          ms: Date.now() - loadStartedAt,
          width: live2dModel.internalModel ? live2dModel.internalModel.width : null,
          height: live2dModel.internalModel ? live2dModel.internalModel.height : null,
          groups: groups,
          groupCounts: groups.map(function (group) { return (defs[group] || []).length; }),
          motionTotal: groups.reduce(function (sum, group) { return sum + (defs[group] || []).length; }, 0),
          hiddenParts: hiddenPartState.slice(),
          at: Date.now()
        };
      } catch (e) {}
    } catch (error) {
      _loadingModelId = null;
      loadedModelId = null;
      unloadLive2dModel();
      window.__lastModelLoadError = { id: model.id, name: model.name, kind: model.kind, message: error.message || String(error), at: Date.now() };
      showLive2dError("Live2D 加载错误", error.message || String(error));
      // WebGL context 偶发失败（连续切换大量模型后偶见 getAttribLocation 错误）：
      // 销毁并重建 PIXI/WebGL 上下文后自动重试（最多 2 次）
      var errorText = String((error && error.message) || error);
      var isWebglError = /getAttribLocation|WebGL|context lost|WebGLProgram/i.test(errorText);
      var retry = window.__petLoadRetry || { id: "", count: 0 };
      if (retry.id !== model.id) retry = { id: model.id, count: 0 };
      if (retry.count < 2 && Date.now() - loadStartedAt > 200) {
        retry.count += 1;
        window.__petLoadRetry = retry;
        if (isWebglError) {
          try { resetLive2dWebglContext(); } catch (e) {}
        }
        setTimeout(function () {
          try { loadLive2dModel(model); } catch (e) {}
        }, 900);
      }
    }
  }


  function clearBubbleHold(source) {
    if (hideTimer[source]) {
      clearTimeout(hideTimer[source]);
      hideTimer[source] = null;
    }
    holdUntil[source] = 0;
    holdSignature[source] = "";
    dismissedSignature[source] = "";
  }

  function scheduleBubbleHide(source, bubble) {
    if (hideTimer[source]) clearTimeout(hideTimer[source]);
    hideTimer[source] = setTimeout(() => {
      if (bubble) bubble.classList.remove("visible");
      dismissedSignature[source] = holdSignature[source];
      holdUntil[source] = 0;
      hideTimer[source] = null;
    }, 30000);
  }

  function replySignature(item, replyText) {
    if (!item) return "";
    return [
      item.sessionId || item.session_id || "",
      item.timestamp || item.updatedAt || "",
      replyText || ""
    ].join("|");
  }

  function renderBubble(source, item) {
    const bubble = document.getElementById(`bubble-${source}`);
    const dot = document.getElementById(`dot-${source}`);
    const title = document.getElementById(`title-${source}`);
    const text = document.getElementById(`text-${source}`);
    if (!bubble || !dot || !title || !text) return;

    const now = Date.now();
    let kind = item && item.kind ? item.kind : "idle";
    const content = item && item.text ? item.text : "";
    const holding = holdUntil[source] > now && lastReply[source];
    const terminalReply = kind === "complete" || kind === "completed" || (kind === "idle" && content);

    if ((!item || (kind === "idle" && !content)) && !holding) {
      bubble.classList.remove("visible");
      return;
    }

    if (terminalReply || holding) {
      const replyText = content && content !== "complete" ? content : lastReply[source];
      if (!replyText) {
        bubble.classList.remove("visible");
        return;
      }

      const signature = replySignature(item, replyText);
      if (!holding && terminalReply && dismissedSignature[source] === signature) {
        bubble.classList.remove("visible");
        return;
      }

      lastReply[source] = replyText;
      if (terminalReply) {
        if (holdSignature[source] !== signature) {
          holdSignature[source] = signature;
          dismissedSignature[source] = "";
          holdUntil[source] = now + 30000;
          scheduleBubbleHide(source, bubble);
        }
      }

      if (holdUntil[source] && now >= holdUntil[source]) {
        bubble.classList.remove("visible");
        return;
      }

      kind = "complete";
      dot.className = `dot ${dotKind(kind)}`;
      title.textContent = `${sourceName(source)} 回复`;
      text.textContent = replyText;
      bubble.classList.add("visible");
      return;
    }

    clearBubbleHold(source);

    if (content && kind === "replying") lastReply[source] = content;

    dot.className = `dot ${dotKind(kind)}`;

    if (kind === "thinking") {
      title.textContent = `${sourceName(source)} 思考中`;
      text.textContent = lastReply[source] || "";
    } else if (kind === "running-tool" || kind === "tool_use") {
      const label = toolLabel(item && item.tool);
      title.textContent = `${sourceName(source)} 工作中${label ? ` - ${label}` : ""}`;
      text.textContent = lastReply[source] || content || (label ? `正在调用：${label}` : "");
    } else if (kind === "replying") {
      title.textContent = `${sourceName(source)} 回复中`;
      text.textContent = content || lastReply[source] || "";
    } else if (kind === "error") {
      title.textContent = `${sourceName(source)} 出错`;
      text.textContent = content || lastReply[source] || "";
    } else {
      title.textContent = `${sourceName(source)} ${statusLabel(kind)}`;
      text.textContent = content || lastReply[source] || "";
    }

    bubble.classList.add("visible");
  }

  // SFW 毛玻璃遮罩：默认开启（state.sfw.sfw === true）。
  // 测试/截图可用启动参数强制 NSFW，或调用 __petDebug.setNsfw(true) 临时覆盖（不持久化）。
  function applySfwState(state) {
    var sfw = (state && state.sfw) || {};
    var baseNsfw = Boolean(sfw.nsfw);
    var nsfw = debugNsfwOverride === null ? baseNsfw : debugNsfwOverride;
    var active = !nsfw;
    var blur = Number(sfw.blur) || 22;
    document.body.classList.toggle("sfw-on", active);
    document.documentElement.style.setProperty("--sfw-blur", blur + "px");
    var overlay = document.getElementById("sfw-overlay");
    if (overlay) {
      overlay.dataset.state = active ? "sfw" : "nsfw";
      overlay.title = active ? "SFW 毛玻璃遮罩已开启（托盘菜单可切到 NSFW 清晰）" : "";
    }
    window.__sfwState = {
      active: active,
      nsfw: nsfw,
      savedNsfw: Boolean(sfw.savedNsfw),
      forced: sfw.forced === undefined ? null : sfw.forced,
      debugOverride: debugNsfwOverride,
      blur: blur
    };
    return window.__sfwState;
  }

  function renderPetState(state) {
    // 场景配置/AI 开关：主进程随 state 下发，模型切换后由 loadLive2dModel 再按模型取场景
    sceneRuntime.config = (state && state.sceneConfig) || sceneRuntime.config;
    var aiCfg = (sceneRuntime.config && sceneRuntime.config.ai) || {};
    sceneRuntime.aiEnabled = (state && state.sceneAutoEnabled !== false) && aiCfg.enabled !== false;
    // 背景默认关闭（完全透明）；管理页「显示背景」开关可手动打开
    document.body.classList.toggle("show-background", Boolean(state && state.config && state.config.showBackground === true));
    syncTavernBarVisibility();
    applySfwState(state);
    loadLive2dModel(state.selectedModel);
    renderBubble("codex", pickSource(state.status, "codex"));
    renderBubble("claude", pickSource(state.status, "claude"));
    updateLive2dMotion(state.status);
    // 模型列表/场景配置更新后刷新能力清单（用于 AI function calling 工具 schema）
    reportAiCapabilities();
    // 悬浮层：配置/窗口/模型变化后重新应用（气泡 follow 锚点、百分比位置）
    applyOverlayLayout();
  }

  function bindPetInteractions() {
    // 桌宠缩放：Ctrl+滚轮 ±1%（按住 Shift ±5%），25%~200%，与托盘/管理页/快捷键同一套重算
    var petStage = document.getElementById("pet-stage");
    if (petStage) {
      petStage.addEventListener("wheel", function(event) {
        if (!event.ctrlKey) return;
        event.preventDefault();
        var current = Number((appState && appState.config && appState.config.petScale) || 1) || 1;
        var step = event.deltaY < 0 ? 0.01 : -0.01;
        if (event.shiftKey) step *= 5;
        var next = Math.min(2, Math.max(0.25, Math.round((current + step) * 100) / 100));
        if (next === current) return;
        if (api.setPetScale) api.setPetScale(next);
      }, { passive: false });
    }
    // 场景目录切换：主进程先切模型，加载完成后由 loadLive2dModel 执行目标场景
    if (api.onCatalogScene) {
      api.onCatalogScene(function(payload) {
        if (!payload || !payload.modelId) return;
        pendingCatalogScene = payload;
        if (loadedModelId === payload.modelId) {
          var sceneId = payload.sceneId || "idle";
          pendingCatalogScene = null;
          setTimeout(function() {
            if (loadedModelId === payload.modelId) executeScene(sceneId, { source: "catalog", force: true });
          }, 250);
        }
      });
    }
    if (api.onPetResize) {
      // 主进程 setBounds 后立刻发 pet:resize，此时 renderer 的 window.innerWidth/innerHeight
      // 可能还没更新（OS 窗口尺寸异步生效）。等两帧让布局稳定后再 fit；rAF 被节流时用定时器兜底。
      api.onPetResize(function() {
        var refit = function() {
          try { fitLive2dModel(); } catch (e) {}
          scheduleOverlayLayout(160, true);
        };
        if (window.requestAnimationFrame) {
          window.requestAnimationFrame(function() {
            window.requestAnimationFrame(refit);
          });
          setTimeout(refit, 120);
        } else {
          setTimeout(refit, 60);
        }
      });
    }
    function cursorLocalPosition(payload) {
      if (!payload) return null;
      if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
        return { x: payload.x, y: payload.y };
      }
      if (payload.point && payload.bounds) {
        return {
          x: payload.point.x - payload.bounds.x,
          y: payload.point.y - payload.bounds.y
        };
      }
      return null;
    }

    api.onCursorPosition((payload) => {
      // 桌宠改造：缓存最新一次全局鼠标位置/窗口位置，手动拖拽与点击互动都依赖它
      lastCursorPayload = payload;
      // hover greet: detect cursor enter/leave via polling
      const localForHover = cursorLocalPosition(payload);
      if (localForHover && payload.width && payload.height) {
        const inside = localForHover.x >= 0 && localForHover.x <= payload.width &&
                       localForHover.y >= 0 && localForHover.y <= payload.height;
        if (inside && !wasCursorInside) {
          if (hoverGreetTimer) clearTimeout(hoverGreetTimer);
          hoverGreetTimer = setTimeout(function() {
            hoverGreetTimer = null;
            triggerRandomChat();
          }, 2000);
        } else if (!inside && wasCursorInside) {
          if (hoverGreetTimer) clearTimeout(hoverGreetTimer);
          hoverGreetTimer = null;
        }
        wasCursorInside = inside;
        // eye tracking: only follow when cursor is inside the window
        if (!inside) {
          resetCursorFocus();
          return;
        }
      }

      // eye tracking / cursor follow (inside window)
      if (!live2dModel || Date.now() < dragReactionUntil) return;
      const local = cursorLocalPosition(payload);
      if (!local) return;
      focusCursorPoint(local.x, local.y, false);
      if (cursorFocusTimer) clearTimeout(cursorFocusTimer);
      cursorFocusTimer = setTimeout(resetCursorFocus, 2500);
    });
    api.onDragState((payload) => {
      const stage = document.getElementById("pet-stage");
      if (!stage) return;
      const active = Boolean(payload && (payload.dragging || payload.active));
      stage.classList.toggle("dragging", active);

      if (!active) {
        dragReactionUntil = Date.now() + 250;
        if (cursorFocusTimer) clearTimeout(cursorFocusTimer);
        cursorFocusTimer = setTimeout(resetCursorFocus, 450);
        return;
      }

      const dx = payload.dx || 0;
      const dy = payload.dy || 0;
      const vx = payload.vx || 0;
      const vy = payload.vy || 0;
      const x = clamp(dx / 28 + vx * 12, -1, 1);
      const y = clamp(-(dy / 36 + vy * 10), -1, 1);
      dragReactionUntil = Date.now() + 350;
      focusLive2d(x, y, false);

      const now = Date.now();
      if (now - lastDragMotionAt > 900) {
        lastDragMotionAt = now;
        playLive2dMotion("flick_head", 0, "drag");
      }
    });

    // 桌宠改造：手动拖动窗口 + 单击互动。
    // 原项目用 CSS -webkit-app-region: drag 拖窗口，但那样 canvas 收不到点击事件；
    // 这里改成 mousedown/mousemove/mouseup 手动移动窗口，位移小于阈值时判定为“点击”。
    function petCursorPoint() {
      if (lastCursorPayload && lastCursorPayload.point) return lastCursorPayload.point;
      return null;
    }

    document.addEventListener("mousedown", function(event) {
      if (event.button !== 0) return;
      // 悬浮层（气泡/输入条/聊天记录面板/拖动把手）上的鼠标操作不触发“拖宠物窗口”
      if (event.target && event.target.closest && event.target.closest(".tavern-bar,.chat-bubble-stack,.chat-bubble,.chat-panel,.overlay-grip")) return;
      var point = petCursorPoint();
      var bounds = lastCursorPayload && lastCursorPayload.bounds;
      if (!point || !bounds) return;
      dragSession = {
        startX: point.x,
        startY: point.y,
        winX: bounds.x,
        winY: bounds.y,
        moved: false,
        startedAt: Date.now()
      };
    });

    document.addEventListener("mousemove", function() {
      if (!dragSession) return;
      var point = petCursorPoint();
      if (!point) return;
      var dx = point.x - dragSession.startX;
      var dy = point.y - dragSession.startY;
      if (!dragSession.moved && Math.abs(dx) + Math.abs(dy) > 5) {
        dragSession.moved = true;
      }
      if (dragSession.moved && api.moveWindow) {
        api.moveWindow({ x: dragSession.winX + dx, y: dragSession.winY + dy });
      }
    });

    document.addEventListener("mouseup", function(event) {
      var session = dragSession;
      dragSession = null;
      if (!session || event.button !== 0) return;
      if (!session.moved && Date.now() - session.startedAt < 700) {
        triggerPetClickInteraction();
      }
    });

    // 聊天悬浮层拖动（气泡/输入条把手/聊天记录面板标题栏）
    bindOverlayDrag();

  }


  function initTavernAudio() {
    if (tavernAudioEl) return;
    tavernAudioEl = document.getElementById("tavern-audio");
    if (!tavernAudioEl) return;
    try {
      var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      try {
        tavernAudioCtx = new AudioContextCtor({ latencyHint: "interactive" });
      } catch(e) {
        tavernAudioCtx = new AudioContextCtor();
      }
      tavernAnalyser = tavernAudioCtx.createAnalyser();
      tavernAnalyser.fftSize = 512;
      tavernAnalyser.smoothingTimeConstant = 0;
      var source = tavernAudioCtx.createMediaElementSource(tavernAudioEl);
      source.connect(tavernAnalyser);
      tavernAnalyser.connect(tavernAudioCtx.destination);
    } catch(e) {}
  }

  function getLipSyncParameterIds() {
    var ids = [];
    try {
      var settings = live2dModel && live2dModel.internalModel && live2dModel.internalModel.settings;
      if (settings && typeof settings.getLipSyncParameters === "function") {
        ids = settings.getLipSyncParameters() || [];
      }
    } catch(e) {}
    ids = ids.concat(["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y"]);
    return ids.filter(function(id, index) {
      return id && ids.indexOf(id) === index;
    });
  }

  function setLive2dMouthOpen(value) {
    if (!live2dModel || !live2dModel.internalModel) return false;
    var core = live2dModel.internalModel.coreModel;
    if (!core) return false;
    var ids = getLipSyncParameterIds();
    var wrote = false;
    for (var i = 0; i < ids.length; i++) {
      try {
        if (typeof core.setParameterValueById === "function") {
          core.setParameterValueById(ids[i], value);
          wrote = true;
        }
      } catch(e) {}
      try {
        if (typeof core.setParamFloat === "function") {
          core.setParamFloat(ids[i], value, 1);
          wrote = true;
        }
      } catch(e) {}
    }
    return wrote;
  }

  function applyLipSyncMouth() {
    setLive2dMouthOpen(tavernLastMouthValue);
  }

  function updateLipSyncFrame() {
    if (!tavernAnalyser || !live2dModel || !tavernLipSyncData) return;
    tavernAnalyser.getByteTimeDomainData(tavernLipSyncData);
    var sum = 0;
    for (var i = 0; i < tavernLipSyncData.length; i++) {
      var centered = (tavernLipSyncData[i] - 128) / 128;
      sum += centered * centered;
    }
    var rms = tavernLipSyncData.length ? Math.sqrt(sum / tavernLipSyncData.length) : 0;
    var target = Math.min(1, Math.max(0, (rms - 0.018) * 9.5));
    target = Math.pow(target, 0.72);
    var smoothing = target > tavernLastMouthValue ? 0.65 : 0.32;
    var value = tavernLastMouthValue + (target - tavernLastMouthValue) * smoothing;
    tavernLastMouthValue = value;
    if (!tavernLipSyncApplyHandler) applyLipSyncMouth();
  }

  function startLipSync() {
    stopLipSync();
    if (!tavernAnalyser || !live2dModel || !live2dApp) return;
    tavernLipSyncData = new Uint8Array(tavernAnalyser.fftSize);
    tavernLipSyncTicker = updateLipSyncFrame;
    live2dApp.ticker.add(tavernLipSyncTicker);
    tavernLipSyncModel = live2dModel.internalModel;
    tavernLipSyncApplyHandler = applyLipSyncMouth;
    try {
      if (tavernLipSyncModel && typeof tavernLipSyncModel.on === "function") {
        tavernLipSyncModel.on("beforeModelUpdate", tavernLipSyncApplyHandler);
      } else {
        tavernLipSyncApplyHandler = null;
      }
    } catch(e) {
      tavernLipSyncApplyHandler = null;
    }
  }

  function stopLipSync() {
    clearSpeakingBodyMotion();
    if (tavernLipSyncTicker && live2dApp) {
      live2dApp.ticker.remove(tavernLipSyncTicker);
    }
    if (tavernLipSyncApplyHandler && tavernLipSyncModel) {
      try {
        if (typeof tavernLipSyncModel.off === "function") {
          tavernLipSyncModel.off("beforeModelUpdate", tavernLipSyncApplyHandler);
        } else if (typeof tavernLipSyncModel.removeListener === "function") {
          tavernLipSyncModel.removeListener("beforeModelUpdate", tavernLipSyncApplyHandler);
        }
      } catch(e) {}
    }
    tavernLipSyncTicker = null;
    tavernLipSyncData = null;
    tavernLipSyncApplyHandler = null;
    tavernLipSyncModel = null;
    tavernLastMouthValue = 0;
    setLive2dMouthOpen(0);
  }

  var _tavernAbort = null;

  function stopTavern() {
    api.tavernAbort();
    if (tavernAudioEl) {
      try {
        tavernAudioEl.pause();
        tavernAudioEl.currentTime = 0;
      } catch(e) {}
    }
    stopLipSync();
    tavernBusy = false;
    var inputEl = document.getElementById("tavern-input");
    if (inputEl) inputEl.disabled = false;
    updateTavernButton();
    if (inputEl) inputEl.focus();
  }

  // ---- 聊天文本输出 + 历史记录（TTS 只是可选增强；没配 Token 也能看文字） ----
  var CHAT_BUBBLE_MAX = 3;

  function chatConfig() {
    return (appState && appState.config && appState.config.chat) || {};
  }

  function chatTextMode() {
    return chatConfig().textMode || "always";
  }

  function ttsIsConfigured() {
    return Boolean(appState && appState.ttsConfigured);
  }

  function currentChatCharacterId() {
    var chars = (appState && appState.characters) || {};
    return tavernCharacterId || chars.activeCharacterId || "";
  }

  function chatCharacterName() {
    var active = (appState && appState.characters && appState.characters.activeCharacter) || null;
    return (active && active.name) || "呆呆";
  }

  function clearChatBubbles() {
    chatBubbles.forEach(function (bubble) {
      if (bubble && bubble._hideTimer) clearTimeout(bubble._hideTimer);
      if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
    });
    chatBubbles = [];
    if (chatTypeTimer) {
      clearInterval(chatTypeTimer);
      chatTypeTimer = null;
    }
  }

  // 打字机：太短/太长的文本直接整段显示，避免等待过久
  function typeChatText(node, text) {
    if (!node) return;
    if (chatTypeTimer) {
      clearInterval(chatTypeTimer);
      chatTypeTimer = null;
    }
    var full = String(text || "");
    if (full.length <= 2 || full.length > 600) {
      node.textContent = full;
      return;
    }
    var index = 0;
    node.textContent = "";
    chatTypeTimer = setInterval(function () {
      index += 2;
      node.textContent = full.slice(0, index);
      if (index >= full.length) {
        clearInterval(chatTypeTimer);
        chatTypeTimer = null;
      }
    }, 24);
  }

  function pushChatBubble(text, options) {
    var stack = document.getElementById("chat-bubble-stack");
    if (!stack || !text) return null;
    var bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    var who = document.createElement("span");
    who.className = "chat-bubble-who";
    who.textContent = chatCharacterName();
    var body = document.createElement("div");
    body.className = "chat-bubble-text";
    bubble.appendChild(who);
    bubble.appendChild(body);
    bubble.addEventListener("click", function () {
      // 拖动气泡调整位置后（阈值已触发）不打开聊天面板
      if (Date.now() < overlaySuppressClickUntil) return;
      setChatPanelOpen(true);
    });
    stack.appendChild(bubble);
    chatBubbles.push(bubble);
    while (chatBubbles.length > CHAT_BUBBLE_MAX) {
      var old = chatBubbles.shift();
      if (old && old._hideTimer) clearTimeout(old._hideTimer);
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    typeChatText(body, text);
    var ms = Number(options && options.ms) || Number(chatConfig().bubbleMs) || 9000;
    bubble._hideTimer = setTimeout(function () {
      bubble.classList.add("leaving");
      setTimeout(function () {
        if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
        chatBubbles = chatBubbles.filter(function (item) { return item !== bubble; });
      }, 220);
    }, Math.max(1500, ms));
    return bubble;
  }

  // always: 总是出字；when-tts-off: 没配 TTS 或合成失败时出字；off: 只语音
  function shouldShowChatText(ttsFailed) {
    var mode = chatTextMode();
    if (mode === "off") return false;
    if (mode === "when-tts-off") return !ttsIsConfigured() || Boolean(ttsFailed);
    return true;
  }

  async function persistChatMessage(role, content) {
    if (!content) return;
    if (chatConfig().persist === false) return;
    try {
      var result = await api.appendChatHistory({
        characterId: currentChatCharacterId(),
        role: role,
        content: String(content),
        ts: Date.now()
      });
      if (result && result.ok && result.entries) {
        chatHistoryEntries = result.entries;
        if (chatPanelOpen) renderChatPanel();
      }
    } catch (e) {
      console.warn("chat history append failed:", e);
    }
  }

  function formatChatTime(ts) {
    var date = new Date(Number(ts) || Date.now());
    var now = new Date();
    var pad = function (value) { return value < 10 ? "0" + value : String(value); };
    var time = pad(date.getHours()) + ":" + pad(date.getMinutes());
    if (date.toDateString() === now.toDateString()) return time;
    return (date.getMonth() + 1) + "/" + date.getDate() + " " + time;
  }

  async function reloadChatHistory() {
    try {
      var result = await api.loadChatHistory(currentChatCharacterId());
      if (result && result.ok) chatHistoryEntries = result.entries || [];
    } catch (e) {
      chatHistoryEntries = [];
    }
    renderChatPanel();
  }

  function renderChatPanel() {
    var list = document.getElementById("chat-panel-list");
    var countEl = document.getElementById("chat-panel-count");
    var hintEl = document.getElementById("chat-panel-hint");
    if (!list) return;
    var entries = chatHistoryEntries || [];
    if (countEl) countEl.textContent = entries.length ? entries.length + " 条" : "";
    if (hintEl) hintEl.textContent = ttsIsConfigured() ? "TTS 已配置 · 文字记录" : "TTS 未配置 · 仅文字";
    var wasNearBottom = chatScrollNearBottom;
    list.innerHTML = "";
    if (!entries.length) {
      var empty = document.createElement("div");
      empty.className = "chat-panel-empty";
      empty.textContent = "还没有聊天记录，发送一条消息试试。";
      list.appendChild(empty);
      return;
    }
    var fragment = document.createDocumentFragment();
    entries.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "chat-msg chat-msg-" + (entry.role === "user" ? "user" : "assistant");
      var meta = document.createElement("div");
      meta.className = "chat-msg-meta";
      var who = document.createElement("span");
      who.textContent = entry.role === "user" ? "我" : chatCharacterName();
      var time = document.createElement("time");
      time.textContent = formatChatTime(entry.ts);
      meta.appendChild(who);
      meta.appendChild(time);
      var content = document.createElement("div");
      content.className = "chat-msg-text";
      content.textContent = entry.content;
      row.appendChild(meta);
      row.appendChild(content);
      fragment.appendChild(row);
    });
    list.appendChild(fragment);
    // 用户上滑看历史时不强制拉回底部
    if (wasNearBottom) list.scrollTop = list.scrollHeight;
  }

  function setChatPanelOpen(open) {
    var panel = document.getElementById("chat-panel");
    if (!panel) return;
    chatPanelOpen = Boolean(open);
    panel.classList.toggle("open", chatPanelOpen);
    panel.setAttribute("aria-hidden", chatPanelOpen ? "false" : "true");
    if (chatPanelOpen) {
      chatScrollNearBottom = true;
      reloadChatHistory();
    }
  }

  function toggleChatPanelUi() {
    setChatPanelOpen(!chatPanelOpen);
  }

  function bindChatPanel() {
    var list = document.getElementById("chat-panel-list");
    var closeBtn = document.getElementById("chat-panel-close");
    var clearBtn = document.getElementById("chat-panel-clear");
    if (closeBtn) closeBtn.addEventListener("click", function () { setChatPanelOpen(false); });
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (!window.confirm("清空当前角色的聊天记录？")) return;
        api.clearChatHistory(currentChatCharacterId()).then(function () {
          chatHistoryEntries = [];
          renderChatPanel();
          showSceneToast("聊天记录已清空", "chat", 2000);
        });
      });
    }
    if (list) {
      list.addEventListener("scroll", function () {
        chatScrollNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      });
    }
    if (api.onToggleChat) api.onToggleChat(function () { toggleChatPanelUi(); });
    if (api.onFocusChat) {
      api.onFocusChat(function () {
        setChatPanelOpen(true);
        var input = document.getElementById("tavern-input");
        if (input) input.focus();
      });
    }
    reloadChatHistory();
  }

  async function sendTavernMessage(text) {
    if (tavernBusy || !text || !text.trim()) return;
    tavernBusy = true;
    updateTavernButton();
    var inputEl = document.getElementById("tavern-input");
    if (inputEl) { inputEl.disabled = true; inputEl.value = ""; }

    try {
      document.getElementById("tavern-input").placeholder = "呆呆思考中...";
      tavernHistory.push({ role: "user", content: text });
      if (tavernHistory.length > 20) tavernHistory = tavernHistory.slice(-20);

      initTavernAudio();

      var result = await api.tavernChat(tavernHistory);
      if (!result.ok) throw new Error(result.error || "chat failed");
      var reply = result.reply;
      tavernHistory.push({ role: "assistant", content: reply });
      // 用户消息里的明确动作指令 > AI 标签 > 回复关键词（显示/TTS 前标签已在主进程剥离）
      handleAiReply(reply, { userText: text, tagId: result.scene });

      // 文本先出：不 await TTS（没配 Token / 合成失败都不该让用户干等）
      var textShown = shouldShowChatText(false);
      if (textShown) pushChatBubble(reply);
      await persistChatMessage("user", text);
      await persistChatMessage("assistant", reply);

      var ttsFailed = false;
      var tts = await api.tavernTts(reply);
      if (tts && tts.ok && tts.url && tavernAudioEl && tavernAudioCtx) {
        try {
          if (tavernAudioCtx.state === "suspended") await tavernAudioCtx.resume();
          tavernAudioEl.src = tts.url;
          tavernAudioEl.onplay = function() { startLipSync(); scheduleSpeakingBodyMotion(120); };
          tavernAudioEl.onended = function() { stopLipSync(); scheduleRandomBodyMotion(2000); };
          tavernAudioEl.onerror = function() { stopLipSync(); scheduleRandomBodyMotion(2000); };
          await tavernAudioEl.play();
        } catch (playError) {
          ttsFailed = true;
          console.warn("tavern audio play failed:", playError);
        }
      } else {
        ttsFailed = true;
      }
      // 配了 TTS 却失败：补一条文本 + 提示，别让用户既没声音也没字
      if (ttsFailed && !textShown && shouldShowChatText(true)) {
        pushChatBubble(reply);
      }
      if (ttsFailed && ttsIsConfigured()) {
        showSceneToast("语音生成失败，已用文字显示", "tavern", 2600);
      }
    } catch(e) {
      console.error("Tavern error:", e);
      var emptyEl = document.getElementById("empty-pet");
      if (emptyEl) {
        emptyEl.style.display = "grid";
        emptyEl.querySelector("strong").textContent = "聊天出错";
        emptyEl.querySelector("span").textContent = String(e.message || e).slice(0, 100);
        setTimeout(function() { emptyEl.style.display = "none"; }, 4000);
      }
    } finally {
    _tavernAbort = null;
    tavernBusy = false;
    if (inputEl) { inputEl.disabled = false; inputEl.placeholder = "和呆呆聊天..."; }
    updateTavernButton();
    if (inputEl && !tavernBusy) inputEl.focus();
  }
  }

  function updateTavernButton() {
    var sendBtn = document.getElementById("tavern-send");
    if (!sendBtn) return;
    sendBtn.textContent = tavernBusy ? "■" : "↵";
    sendBtn.style.background = tavernBusy ? "rgba(220, 38, 38, 0.8)" : "rgba(37, 99, 235, 0.7)";
    sendBtn.title = tavernBusy ? "打断" : "发送";
  }

  function bindTavernInput() {
    var inputEl = document.getElementById("tavern-input");
    var sendBtn = document.getElementById("tavern-send");
    if (!inputEl || !sendBtn) return;
    window.__sendTavernMessage = sendTavernMessage;
    // Focus the Electron window for keyboard input
    inputEl.addEventListener("focus", function() { api.tavernFocusWindow(); });
    inputEl.addEventListener("click", function() { api.tavernFocusWindow(); inputEl.focus(); });
    inputEl.addEventListener("focus", function() { inputEl.select(); });
    inputEl.addEventListener("click", function() { inputEl.focus(); });
    inputEl.addEventListener("keydown", function(e) {
      if (e.key === "Enter") { e.preventDefault(); sendTavernMessage(inputEl.value); }
    });
    sendBtn.addEventListener("click", function() {
      if (tavernBusy) { stopTavern(); }
      else { sendTavernMessage(inputEl.value); }
    });
    api.tavernCleanup();
  }

  // 场景面板 / 托盘快捷场景：主进程把命令转发到宠物窗
  function bindSceneCommands() {
    if (api.onSceneCommand) {
      api.onSceneCommand(function(payload) {
        if (!payload) return;
        if (payload.reset) {
          resetSceneState({});
          return;
        }
        if (payload.id) {
          executeScene(payload.id, { source: payload.source || "panel" });
        }
      });
    }
    // AI function calling：主进程把 AI 的工具调用转发给渲染进程执行
    if (api.onToolCall) {
      api.onToolCall(function(payload) {
        if (!payload) return;
        var result = executeToolCall(payload.name, payload.args);
        Promise.resolve(result).then(function(resolved) {
          try { if (api.reportToolResult) api.reportToolResult(payload.requestId, resolved); } catch (e) {}
        });
      });
    }
    // 供自动化/主进程查询场景列表
    window.__petScenes = function() { return window.__petDebug ? window.__petDebug.scenes() : []; };
    reportSceneState();
    reportAiCapabilities();
  }

  async function boot() {
    appState = await api.getState();
    if (view === "manager") {
      renderManager(appState);
    } else {
      renderPetShell();
      bindPetInteractions();
      renderPetState(appState);
      bindChatPanel();
      bindSceneCommands();
    }
    bindTavernInput();
    api.onUpdate((next) => {
      appState = next;
      if (view === "manager") {
        // If user is interacting with a SELECT (dropdown open), defer render
        if (suppressManagerRender) {
          pendingManagerState = next;
          return;
        }
        // Save INPUT/TEXTAREA focus to restore after render
        var focused = document.activeElement;
        var focusedId = focused && focused.id ? focused.id : null;
        var focusedTag = focused ? focused.tagName : "";
        var selStart = (focusedTag === "INPUT" || focusedTag === "TEXTAREA") && typeof focused.selectionStart === "number" ? focused.selectionStart : null;
        var selEnd = (focusedTag === "INPUT" || focusedTag === "TEXTAREA") && typeof focused.selectionEnd === "number" ? focused.selectionEnd : null;
        renderManager(appState);
        if (focusedId) {
          var el = document.getElementById(focusedId);
          if (el) {
            el.focus();
            if (selStart !== null && typeof el.selectionStart === "number") {
              el.setSelectionRange(selStart, selEnd !== null ? selEnd : selStart);
            }
          }
        }
      } else {
        renderPetState(appState);
      }
    });
  }

  // 桌宠改造：自动化自检钩子（不影响正常交互）
  window.__petDebug = {
    get loadedModelId() { return loadedModelId; },
    get linkCount() { return (modelLinks || []).length; },
    get clicks() { return window.__petClicks || 0; },
    click: function() { triggerPetClickInteraction(); },
    playRandom: function() { return playRandomBodyMotion("idle"); },
    playIndex: function(group, index) {
      try { live2dModel.motion(group || "", index || 0); return true; } catch (e) { return String(e); }
    },
    motionFiles: function() {
      try {
        var defs = motionDefinitions();
        var out = {};
        Object.keys(defs).forEach(function(g) {
          out[g] = (defs[g] || []).map(function(entry) {
            return entry && (entry.file || entry.File);
          });
        });
        return out;
      } catch (e) { return null; }
    },
    safeIndices: function(group) { return safeMotionIndices(group || ""); },
    motionState: function() {
      try {
        var mm = live2dModel.internalModel.motionManager;
        return {
          hasCurrent: Boolean(mm.currentMotion),
          queue: (mm.motionQueue || []).length,
          groups: Object.keys(mm.definitions || {}),
          counts: Object.keys(mm.definitions || {}).map(function(k) { return (mm.definitions[k] || []).length; })
        };
      } catch (e) { return String(e); }
    },
    // 自检：Cubism2 运行时的 parts 接口（用于隐藏模型里的背景部件）
    coreModel: function() {
      try { return live2dModel && live2dModel.internalModel ? live2dModel.internalModel.coreModel : null; } catch (e) { return null; }
    },
    partCount: function() {
      try {
        var core = this.coreModel();
        if (!core) return -1;
        // Cubism3/4：CubismModel.getPartCount()
        if (typeof core.getPartCount === "function") {
          var count = core.getPartCount();
          if (typeof count === "number" && count >= 0) return count;
        }
        // Cubism2：按 getPartsOpacity 逐索引探测
        if (typeof core.getPartsOpacity !== "function") return -1;
        for (var i = 0; i < 300; i++) {
          var v;
          try { v = core.getPartsOpacity(i); } catch (e) { return i; }
          if (typeof v !== "number" || Number.isNaN(v)) return i;
        }
        return 300;
      } catch (e) { return -1; }
    },
    partIds: function() {
      try {
        var core = this.coreModel();
        if (!core) return [];
        var model = core._model || core.model;
        if (model && model.parts && Array.isArray(model.parts.ids)) return model.parts.ids.slice();
        return [];
      } catch (e) { return []; }
    },
    // Cubism3/4 绘图对象（drawable）透明度：用于隐藏内嵌背景部件
    drawableInfo: function() {
      try {
        var core = this.coreModel();
        var model = core && (core._model || core.model);
        if (!model || !model.drawables) return null;
        return {
          count: model.drawables.opacities.length,
          parentPartIndices: Array.from(model.drawables.parentPartIndices || []),
          opacities: Array.from(model.drawables.opacities || []),
          partIds: model.parts && model.parts.ids ? model.parts.ids.slice() : [],
          partCount: model.parts ? model.parts.count : 0
        };
      } catch (e) { return null; }
    },
    setDrawableOpacity: function(index, value) {
      try {
        var core = this.coreModel();
        var model = core && (core._model || core.model);
        if (!model || !model.drawables || !model.drawables.opacities) return false;
        model.drawables.opacities[Number(index)] = Number(value);
        return true;
      } catch (e) { return false; }
    },
    setPartOpacityByKey: function(key, opacity) {
      try { return setPartOpacityKey(this.coreModel(), key, Number(opacity)); } catch (e) { return false; }
    },
    hiddenParts: function() { return hiddenPartState.slice(); },
    setHiddenParts: function(parts) {
      hiddenPartState = Array.isArray(parts) ? parts.slice() : [];
      applyPartOverridesNow();
      return hiddenPartState.slice();
    },
    hiddenDrawables: function() { return hiddenDrawableState.slice(); },
    setHiddenDrawables: function(list) {
      hiddenDrawableState = Array.isArray(list) ? list.map(Number).filter(function(n) { return Number.isFinite(n) && n >= 0; }) : [];
      applyPartOverridesNow();
      return hiddenDrawableState.slice();
    },
    clearHiddenParts: function() {
      hiddenPartState = [];
      hiddenDrawableState = [];
      debugC4HiddenPart = null;
      debugC4HiddenDrawables = [];
      try {
        var count = this.partCount();
        for (var i = 0; i < count; i++) setPartOpacityKey(this.coreModel(), i, 1);
      } catch (e) {}
      return true;
    },
    // 自动化/自检：渲染一帧并统计画布不透明像素占比（用于背景部件探测）
    alphaCoverage: function() {
      try {
        var frame = extractStagePixels();
        if (!frame) return -1;
        var data = frame.data;
        var visible = 0;
        var total = 0;
        for (var i = 3; i < data.length; i += 4) {
          total += 1;
          if (data[i] > 16) visible += 1;
        }
        return total ? visible / total : -1;
      } catch (e) { return -1; }
    },
    capturePixelBaseline: function() {
      try {
        var frame = extractStagePixels();
        if (!frame) return { ok: false, error: "no frame" };
        debugPixelBaseline = frame;
        return { ok: true, width: frame.width, height: frame.height, bytes: frame.data.length };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    pixelState: function() {
      try {
        var current = extractStagePixels();
        var diff = pixelDiffAgainst(debugPixelBaseline, current, {});
        var coverage = -1;
        if (current) {
          var visible = 0;
          var total = 0;
          for (var i = 3; i < current.data.length; i += 4) {
            total += 1;
            if (current.data[i] > 16) visible += 1;
          }
          coverage = total ? visible / total : -1;
        }
        return { diff: diff, coverage: coverage };
      } catch (e) { return { error: String(e) }; }
    },
    // Cubism3/4 drawable 几何（内嵌背景检测：覆盖全画布、绘制顺序靠前的 drawable）
    drawableGeometry: function() {
      try {
        var core = this.coreModel();
        var model = core && c4ModelOf(core);
        if (!model || !model.drawables) return null;
        var d = model.drawables;
        var vp = d.vertexPositions || [];
        var vc = d.vertexCounts || [];
        var parents = d.parentPartIndices || [];
        var ops = d.opacities || [];
        var orders = d.renderOrders || d.drawOrders || [];
        var parts = model.parts && model.parts.ids ? model.parts.ids : [];
        var canvas = model.canvasinfo || null;
        var out = [];
        var union = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        for (var i = 0; i < vp.length; i += 1) {
          var arr = vp[i];
          var n = vc[i] || 0;
          var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (var k = 0; k < n * 2; k += 2) {
            var x = arr[k];
            var y = arr[k + 1];
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
          if (n > 0) {
            union.x0 = Math.min(union.x0, x0);
            union.y0 = Math.min(union.y0, y0);
            union.x1 = Math.max(union.x1, x1);
            union.y1 = Math.max(union.y1, y1);
          }
          out.push({
            index: i,
            partIndex: parents[i],
            partId: parents[i] >= 0 ? parts[parents[i]] : null,
            opacity: ops[i],
            renderOrder: orders ? orders[i] : null,
            x0: x0, y0: y0, x1: x1, y1: y1,
            width: n > 0 ? x1 - x0 : 0,
            height: n > 0 ? y1 - y0 : 0,
            vertexCount: n
          });
        }
        var unionW = union.x1 - union.x0;
        var unionH = union.y1 - union.y0;
        return { canvas: canvas, union: union, unionWidth: unionW, unionHeight: unionH, drawables: out };
      } catch (e) { return null; }
    },
    // 背景部件探测（确定性）：冻结动画后逐个隐藏部件（C2 改部件透明度；C3 改该部件的 drawable 透明度），
    // 与基准画面做像素差：四角区域大比例变化且人物仍有残留 = 内嵌背景/底图。
    probeHiddenParts: function(options) {
      var opts = options || {};
      try {
        if (!live2dApp || !live2dModel) return { ok: false, error: "no model" };
        var core = this.coreModel();
        if (!core) return { ok: false, error: "no core" };
        var count = this.partCount();
        if (count <= 0) return { ok: false, error: "no parts" };
        var model = c4ModelOf(core);
        var isC4 = Boolean(model && model.drawables && model.drawables.opacities);
        var tickerWasRunning = false;
        try { tickerWasRunning = Boolean(live2dApp.ticker.started); live2dApp.ticker.stop(); } catch (e) {}
        var partIds = isC4 ? this.partIds() : [];
        var c2Snapshot = null;
        var c4Snapshot = null;
        var parents = null;
        if (isC4) {
          c4Snapshot = Array.prototype.slice.call(model.drawables.opacities);
          parents = model.drawables.parentPartIndices || [];
        } else {
          c2Snapshot = [];
          for (var s = 0; s < count; s += 1) {
            try { c2Snapshot.push(core.getPartsOpacity(s)); } catch (e) { c2Snapshot.push(1); }
          }
        }
        function measure() {
          var frame = extractStagePixels();
          if (!frame) return null;
          var visible = 0;
          var total = 0;
          for (var i = 3; i < frame.data.length; i += 4) {
            total += 1;
            if (frame.data[i] > 16) visible += 1;
          }
          return { frame: frame, coverage: total ? visible / total : -1 };
        }
        function restore() {
          if (isC4) {
            for (var i = 0; i < c4Snapshot.length; i += 1) model.drawables.opacities[i] = c4Snapshot[i];
          } else {
            for (var j = 0; j < c2Snapshot.length; j += 1) { try { core.setPartsOpacity(j, c2Snapshot[j]); } catch (e) {} }
          }
        }
        var base = measure();
        if (!base) {
          restore();
          if (tickerWasRunning) { try { live2dApp.ticker.start(); } catch (e) {} }
          return { ok: false, error: "no frame" };
        }
        var baselineCoverage = base.coverage;
        var baselineFrame = base.frame;
        var results = [];
        var limit = Math.min(count, Number(opts.limit) || 200);
        for (var i = 0; i < limit; i += 1) {
          if (isC4) {
            for (var d = 0; d < parents.length; d += 1) {
              if (Number(parents[d]) === i) model.drawables.opacities[d] = 0;
            }
          } else {
            try { core.setPartsOpacity(i, 0); } catch (e) {}
          }
          var cur = measure();
          var diff = cur ? pixelDiffAgainst(baselineFrame, cur.frame, {}) : null;
          restore();
          results.push({
            index: i,
            partId: isC4 ? (partIds[i] || null) : null,
            coverage: cur ? cur.coverage : -1,
            coverageDrop: baselineCoverage - (cur ? cur.coverage : -1),
            changedFraction: diff ? diff.changedFraction : null,
            cornerFraction: diff ? diff.cornerFraction : null
          });
        }
        restore();
        if (tickerWasRunning) { try { live2dApp.ticker.start(); } catch (e) {} }
        results.sort(function(a, b) {
          return (b.cornerFraction || 0) - (a.cornerFraction || 0) || (b.changedFraction || 0) - (a.changedFraction || 0);
        });
        return {
          ok: true,
          baselineCoverage: baselineCoverage,
          partCount: count,
          isCubism4: isC4,
          frozen: true,
          results: results
        };
      } catch (e) {
        try { if (live2dApp && live2dApp.ticker) live2dApp.ticker.start(); } catch (_) {}
        return { ok: false, error: String(e) };
      }
    },
    // 逐个隐藏指定 drawable（Cubism3/4，冻结后直接改 opacities），返回四角/整体像素变化（找背景 drawable 用）
    probeHiddenDrawables: function(indexes) {
      var list = Array.isArray(indexes) ? indexes.map(Number).filter(function(n) { return Number.isFinite(n) && n >= 0; }) : [];
      try {
        if (!live2dApp || !live2dModel) return { ok: false, error: "no model" };
        var core = this.coreModel();
        var model = c4ModelOf(core);
        if (!model || !model.drawables || !model.drawables.opacities) return { ok: false, error: "not cubism3/4" };
        var tickerWasRunning = false;
        try { tickerWasRunning = Boolean(live2dApp.ticker.started); live2dApp.ticker.stop(); } catch (e) {}
        var opacities = model.drawables.opacities;
        var snapshot = Array.prototype.slice.call(opacities);
        function measure() {
          var frame = extractStagePixels();
          if (!frame) return null;
          var visible = 0;
          var total = 0;
          for (var i = 3; i < frame.data.length; i += 4) {
            total += 1;
            if (frame.data[i] > 16) visible += 1;
          }
          return { frame: frame, coverage: total ? visible / total : -1 };
        }
        var base = measure();
        if (!base) {
          if (tickerWasRunning) { try { live2dApp.ticker.start(); } catch (e) {} }
          return { ok: false, error: "no frame" };
        }
        var results = [];
        for (var i = 0; i < list.length; i += 1) {
          var idx = list[i];
          if (idx >= opacities.length) continue;
          opacities[idx] = 0;
          var cur = measure();
          var diff = cur ? pixelDiffAgainst(base.frame, cur.frame, {}) : null;
          opacities[idx] = snapshot[idx];
          results.push({
            index: idx,
            coverage: cur ? cur.coverage : -1,
            changedFraction: diff ? diff.changedFraction : null,
            cornerFraction: diff ? diff.cornerFraction : null
          });
        }
        if (tickerWasRunning) { try { live2dApp.ticker.start(); } catch (e) {} }
        results.sort(function(a, b) { return (b.cornerFraction || 0) - (a.cornerFraction || 0) || (b.changedFraction || 0) - (a.changedFraction || 0); });
        return { ok: true, results: results };
      } catch (e) {
        try { if (live2dApp && live2dApp.ticker) live2dApp.ticker.start(); } catch (_) {}
        return { ok: false, error: String(e) };
      }
    },
    setDebugHiddenDrawables: function(list) {
      debugC4HiddenDrawables = Array.isArray(list) ? list.map(Number) : [];
      return debugC4HiddenDrawables.slice();
    },
    restoreAllParts: function() {
      try {
        var count = this.partCount();
        for (var i = 0; i < count; i++) setPartOpacityKey(this.coreModel(), i, 1);
        return true;
      } catch (e) { return false; }
    },
    setPartOpacity: function(index, opacity) {
      try {
        var core = this.coreModel();
        if (!core || typeof core.setPartsOpacity !== "function") return false;
        core.setPartsOpacity(index, opacity);
        return true;
      } catch (e) { return String(e); }
    },
    hideParts: function(indices) {
      var core = this.coreModel();
      if (!core) return false;
      (indices || []).forEach(function(i) {
        try { core.setPartsOpacity(i, 0); } catch (e) {}
      });
      return true;
    },
    // 场景/换装能力自检：持续覆盖模型参数/部件透明度（每帧生效，不写 config）
    setParamOverrides: function(map) {
      debugParamOverrides = map && typeof map === "object" ? Object.assign({}, map) : null;
      bindModelOverrideHandler();
      applyPartOverridesNow();
      return debugParamOverrides;
    },
    // 冻结动画（停 PIXI ticker）后手动写参数并渲染一帧，用于换装/表情状态取证
    pauseAnimation: function(paused) {
      try {
        if (!live2dApp) return false;
        if (paused) live2dApp.ticker.stop();
        else live2dApp.ticker.start();
        return true;
      } catch (e) { return String(e); }
    },
    setParamState: function(map, render) {
      try {
        var core = this.coreModel();
        if (!core) return false;
        if (map && typeof map === "object") {
          Object.keys(map).forEach(function(key) {
            var v = Number(map[key]);
            if (!Number.isFinite(v)) return;
            var idx = resolveParamIndex(core, key);
            try {
              if (idx >= 0 && typeof core.setParamFloat === "function") core.setParamFloat(idx, v, 1);
              else if (typeof core.setParameterValueById === "function") core.setParameterValueById(String(key), v);
            } catch (e) {}
          });
        }
        try { if (typeof core.update === "function") core.update(); } catch (e) {}
        if (render !== false) {
          try { live2dApp.renderer.render(live2dApp.stage); } catch (e) {}
        }
        return true;
      } catch (e) { return String(e); }
    },
    stopAllMotions: function() {
      try {
        live2dModel.internalModel.motionManager.stopAllMotions();
        return true;
      } catch (e) { return String(e); }
    },
    paramRanges: function() {
      try {
        var core = this.coreModel();
        var out = [];
        for (var i = 0; i < 60; i++) {
          var cur = core.getParamFloat(i);
          if (typeof cur !== "number" || Number.isNaN(cur)) break;
          out.push({ index: i, value: cur });
        }
        return out;
      } catch (e) { return []; }
    },
    clearParamOverrides: function() {
      debugParamOverrides = null;
      return true;
    },
    setPartOverrides: function(map) {
      debugPartOverrides = map && typeof map === "object" ? Object.assign({}, map) : null;
      bindModelOverrideHandler();
      applyPartOverridesNow();
      return debugPartOverrides;
    },
    clearPartOverrides: function() {
      debugPartOverrides = null;
      return true;
    },
    paramList: function() {
      try {
        var core = this.coreModel();
        var out = [];
        for (var i = 0; i < 60; i++) {
          var v = core.getParamFloat(i);
          if (typeof v !== "number" || Number.isNaN(v)) break;
          out.push({ index: i, value: v });
        }
        return out;
      } catch (e) { return []; }
    },
    modelInfo: function() {
      try {
        var defs = motionDefinitions ? motionDefinitions() : {};
        var groups = Object.keys(defs);
        return {
          id: loadedModelId,
          kind: currentModelRecord && currentModelRecord.kind,
          width: live2dModel.internalModel.width,
          height: live2dModel.internalModel.height,
          groups: groups,
          counts: groups.map(function(k) { return defs[k].length; }),
          motionTotal: groups.reduce(function(sum, k) { return sum + defs[k].length; }, 0),
          linkCount: (modelLinks || []).length,
          hiddenParts: hiddenPartState.slice(),
          partCount: this.partCount(),
          lastLoad: window.__lastModelLoad || null
        };
      } catch (e) { return null; }
    },
    // 63 模型自动化：当前加载情况/能力/声音/隐藏部件的完整快照
    modelLoadInfo: function() {
      return {
        loadedModelId: loadedModelId,
        loadingModelId: _loadingModelId,
        loadToken: _loadToken,
        currentModel: currentModelRecord ? {
          id: currentModelRecord.id,
          name: currentModelRecord.name,
          kind: currentModelRecord.kind,
          bundle: currentModelRecord.bundle || "",
          game: currentModelRecord.game || "",
          modelPath: currentModelRecord.modelPath,
          links: (currentModelRecord.links || []).length
        } : null,
        lastLoad: window.__lastModelLoad || null,
        lastError: window.__lastModelLoadError || null,
        linkCount: (modelLinks || []).length,
        hiddenParts: hiddenPartState.slice(),
        sound: {
          url: window.__lastPetSoundUrl || "",
          playing: Boolean(window.__lastPetSoundPlaying),
          error: window.__lastPetSoundError || ""
        }
      };
    },
    lastLoad: function() { return window.__lastModelLoad || null; },
    // 视图变换快照：缩放/位置/窗口尺寸/边界（自动适配自检用）
    viewTransform: function() {
      try {
        var b = live2dModel.getBounds();
        return {
          scale: [live2dModel.scale.x, live2dModel.scale.y],
          position: [live2dModel.position.x, live2dModel.position.y],
          anchor: [live2dModel.anchor.x, live2dModel.anchor.y],
          screen: [live2dApp.screen.width, live2dApp.screen.height],
          bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
          internalWidth: live2dModel.internalModel.width,
          internalHeight: live2dModel.internalModel.height,
          effectiveScale: effectiveModelScale()
        };
      } catch (e) { return String(e); }
    },
    links: function() { return (modelLinks || []).slice(0, 300); },
    // ---- 场景目录自检 ----
    catalogEntry: function() { return currentCatalogEntry(); },
    catalogEntries: function() { return catalogEntries(); },
    catalogSceneFor: function(modelId) { return catalogEntryBySceneId(modelId); },
    isAuxiliary: function() { return isAuxiliaryModel(currentModelRecord); },
    pendingCatalogScene: function() { return pendingCatalogScene; },
    triggerCatalog: function(modelId, sceneId) { return triggerCatalogScene(modelId, sceneId); },
    catalogMatch: function(text) { var m = matchCatalogByText(text); return m ? { modelId: m.entry.modelId, sceneLabel: m.entry.sceneLabel, term: m.term } : null; },
    // 背景透明检查：模型舞台的不透明像素占比（0=完全透明）
    stageAlpha: function() {
      try {
        var frame = extractStagePixels();
        if (!frame) return -1;
        var visible = 0;
        var total = 0;
        for (var i = 3; i < frame.data.length; i += 4) {
          total += 1;
          if (frame.data[i] > 16) visible += 1;
        }
        return total ? visible / total : -1;
      } catch (e) { return -1; }
    },
    // 手动重新 fit（窗口尺寸由外部改过时排障用）
    refit: function() { fitLive2dModel(); return this.viewTransform(); },
    // 聊天悬浮层自检：overlay 配置 + 实际应用位置（follow 锚点为模型头顶）
    overlay: function() { return window.__petOverlayState || null; },
    relayoutOverlay: function() { applyOverlayLayout(true); return window.__petOverlayState; },
    // 强制重建 renderer 后备缓冲（窗口捕获/合成后 GL 缓冲尺寸可能失同步时修复用）
    forceRendererResize: function() {
      if (!live2dApp || !live2dApp.renderer) return null;
      try {
        live2dApp.renderer.resize(Number(window.innerWidth) || 1, Number(window.innerHeight) || 1);
        live2dApp.renderer.render(live2dApp.stage);
      } catch (e) { return { error: String(e) }; }
      return { screen: [live2dApp.screen.width, live2dApp.screen.height], renderer: [live2dApp.renderer.width, live2dApp.renderer.height], art: measureScreenArtBounds() };
    },
    // 最近一次 fit 的计算过程（缩放/画布/实际内容/最终 transform）
    lastFit: function() { return lastFitInfo; },
    // 自动化截图：暂停/恢复随机身体动作（避免换装/位移改变绘制内容包围盒）
    setRandomMotionEnabled: function(enabled) {
      randomBodyMotionPaused = !enabled;
      if (randomBodyMotionPaused) {
        clearRandomBodyMotion();
      } else {
        scheduleRandomBodyMotion(2500);
      }
      return !randomBodyMotionPaused;
    },
    // 自动化截图：冻结当前姿态（停止场景/动作/随机动作），保证缩放截图与测量使用同一姿态
    freezePose: function() {
      var out = {};
      try { randomBodyMotionPaused = true; clearRandomBodyMotion(); out.randomStopped = true; } catch (e) {}
      try { clearSpeakingBodyMotion(); out.speakingStopped = true; } catch (e) {}
      try {
        stopSceneRuntime({ report: false, resetState: false });
        sceneRuntime.transition = null;
        sceneRuntime.paramState = {};
        out.sceneStopped = true;
      } catch (e) { out.sceneStopped = String(e); }
      try {
        if (live2dModel && live2dModel.internalModel && live2dModel.internalModel.motionManager) {
          live2dModel.internalModel.motionManager.stopAllMotions();
          out.motionsStopped = true;
        }
      } catch (e) { out.motionsStopped = String(e); }
      try { fitLive2dModel(); } catch (e) {}
      return out;
    },
    // 缩放可见性自检（task-14）：渲染器/画布尺寸是否跟随窗口、模型画布是否完整落在窗口内、
    // 模型实际像素包围盒与不透明覆盖率（用于断言 50%~200% 各档“完整可见、无裁切”）。
    visibility: function() {
      try {
        if (!live2dApp || !live2dModel) return null;
        var winW = Number(window.innerWidth) || 0;
        var winH = Number(window.innerHeight) || 0;
        var renderer = live2dApp.renderer;
        var canvas = renderer.view;
        // 与 fitLive2dModel 相同的兜底尺寸（C2 模型 internalModel 可能没有画布尺寸）
        var internalW = Number(live2dModel.internalModel && live2dModel.internalModel.width) || 1000;
        var internalH = Number(live2dModel.internalModel && live2dModel.internalModel.height) || 1800;
        var scaleX = Math.abs(live2dModel.scale.x);
        var scaleY = Math.abs(live2dModel.scale.y);
        var ax = live2dModel.anchor ? live2dModel.anchor.x : 0;
        var ay = live2dModel.anchor ? live2dModel.anchor.y : 0;
        var canvasW = internalW * scaleX;
        var canvasH = internalH * scaleY;
        var canvasLeft = live2dModel.position.x - internalW * ax * scaleX;
        var canvasTop = live2dModel.position.y - internalH * ay * scaleY;
        var frame = extractStagePixels();
        var pixel = null;
        if (frame) {
          var data = frame.data;
          var minX = frame.width;
          var minY = frame.height;
          var maxX = -1;
          var maxY = -1;
          var visible = 0;
          for (var y = 0; y < frame.height; y += 1) {
            var row = y * frame.width * 4;
            for (var x = 0; x < frame.width; x += 1) {
              if (data[row + x * 4 + 3] > 16) {
                visible += 1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          var total = frame.width * frame.height;
          pixel = {
            width: frame.width,
            height: frame.height,
            coverage: total ? visible / total : 0,
            bbox: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null
          };
          if (pixel.bbox) {
            pixel.bboxPct = {
              left: minX / frame.width,
              top: minY / frame.height,
              right: (maxX + 1) / frame.width,
              bottom: (maxY + 1) / frame.height
            };
          }
        }
        return {
          window: { width: winW, height: winH, dpr: Number(window.devicePixelRatio) || 1 },
          screen: { width: live2dApp.screen.width, height: live2dApp.screen.height },
          renderer: { width: renderer.width, height: renderer.height, resolution: renderer.resolution },
          canvasCss: {
            styleWidth: parseFloat(canvas.style.width) || null,
            styleHeight: parseFloat(canvas.style.height) || null,
            clientWidth: canvas.clientWidth,
            clientHeight: canvas.clientHeight
          },
          model: {
            position: [live2dModel.position.x, live2dModel.position.y],
            scale: [live2dModel.scale.x, live2dModel.scale.y],
            anchor: [ax, ay],
            internalWidth: internalW,
            internalHeight: internalH,
            effectiveScale: effectiveModelScale()
          },
          canvasBox: { x: canvasLeft, y: canvasTop, width: canvasW, height: canvasH },
          canvasFits: canvasLeft >= -0.5 && canvasTop >= -0.5 &&
            canvasLeft + canvasW <= winW + 0.5 && canvasTop + canvasH <= winH + 0.5,
          pixel: pixel
        };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    },
    // 实际绘制内容包围盒（CSS px，含画出模型画布外的部分）：判断模型是否真正完整可见
    artBounds: function() {
      var art = measureScreenArtBounds();
      if (!art) return null;
      art.window = { width: Number(window.innerWidth) || 0, height: Number(window.innerHeight) || 0 };
      art.fits = art.left >= -0.5 && art.top >= -0.5 &&
        art.right <= art.window.width + 0.5 && art.bottom <= art.window.height + 0.5;
      art.margins = {
        left: art.left,
        top: art.top,
        right: art.window.width - art.right,
        bottom: art.window.height - art.bottom
      };
      return art;
    },
    // drawable 顶点几何包围盒（模型单位 + 当前变换下 CSS 坐标）：不读像素、结果稳定，
    // 缩放适配实际使用该数据；artBounds 仍用于像素级复核。
    geometryBounds: function() {
      var units = measureDrawableArtBoundsUnits();
      if (!units) return null;
      var mw = units.canvas.width;
      var mh = units.canvas.height;
      var scaleX = Math.abs(live2dModel.scale.x);
      var scaleY = Math.abs(live2dModel.scale.y);
      var ax = live2dModel.anchor ? live2dModel.anchor.x : 0;
      var ay = live2dModel.anchor ? live2dModel.anchor.y : 0;
      var originX = live2dModel.position.x - mw * ax * scaleX;
      var originY = live2dModel.position.y - mh * ay * scaleY;
      var css = {
        left: originX + units.left * scaleX,
        top: originY + units.top * scaleY,
        right: originX + units.right * scaleX,
        bottom: originY + units.bottom * scaleY,
        width: units.width * scaleX,
        height: units.height * scaleY
      };
      var win = { width: Number(window.innerWidth) || 0, height: Number(window.innerHeight) || 0 };
      return {
        units: units,
        css: css,
        window: win,
        fits: css.left >= -0.5 && css.top >= -0.5 && css.right <= win.width + 0.5 && css.bottom <= win.height + 0.5,
        margins: { left: css.left, top: css.top, right: win.width - css.right, bottom: win.height - css.bottom }
      };
    },
    soundState: function() {
      return {
        url: window.__lastPetSoundUrl || "",
        playing: Boolean(window.__lastPetSoundPlaying),
        error: window.__lastPetSoundError || "",
        enabled: isSoundEnabled()
      };
    },
    // ---- 场景系统自检/自动化钩子 ----
    scenes: function() {
      return listScenes().map(function(scene) {
        return {
          id: scene.id,
          label: scene.label,
          category: scene.category,
          priority: scene.priority,
          params: Object.assign({}, scene.params || {}),
          motions: (scene.motions || []).map(function(motion) { return motion.name; }),
          evidence: scene.evidence || null
        };
      });
    },
    sceneState: function() { return sceneStateSnapshot(); },
    // 当前动作/场景运行状态（排障：确认截图时没有动作在切换姿态）
    motionState: function() {
      var out = {};
      try {
        out.scene = sceneRuntime.current ? {
          id: sceneRuntime.current.id,
          running: sceneRuntime.current.running,
          source: sceneRuntime.current.source,
          startedAt: sceneRuntime.current.startedAt,
          durationMs: sceneRuntime.current.durationMs
        } : null;
        out.lastFinished = sceneRuntime.lastFinished ? sceneRuntime.lastFinished.id : null;
        out.transition = sceneRuntime.transition ? { startedAt: sceneRuntime.transition.startedAt, durationMs: sceneRuntime.transition.durationMs } : null;
      } catch (e) {}
      try {
        var mm = live2dModel && live2dModel.internalModel && live2dModel.internalModel.motionManager;
        if (mm) {
          out.isPlaying = typeof mm.isPlaying === "function" ? Boolean(mm.isPlaying()) : null;
          out.reserveIdleMotion = Boolean(mm.reserveIdleMotion);
          out.currentAudio = mm.currentAudio || null;
          out.motionGroups = mm.definitions ? Object.keys(mm.definitions) : null;
        }
      } catch (e) { out.motionError = String(e); }
      try {
        var core = live2dModel && live2dModel.internalModel ? live2dModel.internalModel.coreModel : null;
        if (core && typeof resolveParamIndex === "function") {
          var pi = resolveParamIndex(core, "Param");
          out.param = pi >= 0 ? Number(core.getParamFloat(pi)) : null;
        }
      } catch (e) {}
      return out;
    },
    sceneConfigSource: function() {
      var cfg = sceneConfigNow();
      return cfg ? { version: cfg.version, models: Object.keys(cfg.models || {}), ai: cfg.ai } : null;
    },
    triggerScene: function(id, options) {
      return executeScene(id, Object.assign({ source: "debug", force: true }, options || {}));
    },
    // 自动化：直接弹一条文字气泡（不经过聊天 API），用于验证悬浮层位置/点击行为
    simulateChatBubble: function(text, ms) {
      return Boolean(pushChatBubble(String(text || "测试气泡"), { ms: Number(ms) || 20000 }));
    },
    simulateAiReply: function(text, userText, force) {
      var raw = String(text || "");
      // 兼容两种签名：simulateAiReply(text, userText, force) / simulateAiReply(text, toolCallsArray)
      var toolCalls = Array.isArray(userText) ? userText : (Array.isArray(arguments[3]) ? arguments[3] : []);
      var user = typeof userText === "string" ? userText : "";
      var tagMatcher = /[[【]\s*scene\s*[:：]\s*([a-z0-9_-]+)\s*[\]】]/gi;
      var tagIds = [];
      var match;
      while ((match = tagMatcher.exec(raw))) {
        var id = String(match[1] || "").toLowerCase();
        if (id && tagIds.indexOf(id) === -1) tagIds.push(id);
      }
      var clean = raw.replace(tagMatcher, "").replace(/\s+/g, " ").trim();
      function finish(toolResults) {
        var base = { text: clean, tagIds: tagIds, toolResults: toolResults || [] };
        var result = handleAiReply(clean, { userText: user, tagId: tagIds[0] || null, force: force !== false });
        if (result && typeof result.then === "function") {
          return result.then(function(resolved) { return Object.assign(base, resolved); });
        }
        return Object.assign(base, result);
      }
      var results = [];
      var chain = Promise.resolve();
      toolCalls.forEach(function(call) {
        chain = chain.then(function() {
          var name = typeof call === "string" ? call : (call && (call.name || (call.function && call.function.name)));
          var args = typeof call === "string" ? {} : (call.args || call.arguments || (call.function && call.function.arguments) || {});
          if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = {}; } }
          return Promise.resolve(executeToolCall(name, args)).then(function(resolved) {
            results.push({ name: name, result: resolved });
          });
        });
      });
      return chain.then(function() { return finish(results); });
    },
    simulateToolCall: function(name, args) {
      return executeToolCall(name, args);
    },
    getCapabilities: function() { return buildAiCapabilities(); },
    reportCapabilitiesNow: function() { return reportAiCapabilities(); },
    toolLog: function() { return toolCallLog.slice(-30); },
    clearToolLog: function() { toolCallLog = []; window.__petToolLog = toolCallLog; return true; },
    resetSceneState: function(options) { return resetSceneState(options || {}); },
    setSceneAutoEnabled: function(value) {
      sceneRuntime.aiEnabled = Boolean(value);
      reportSceneState();
      return sceneRuntime.aiEnabled;
    },
    sceneAiEnabled: function() { return sceneRuntime.aiEnabled; },
    displayScale: function() {
      var entry = sceneEntry();
      return {
        effective: effectiveModelScale(),
        configScale: Number((appState && appState.config && appState.config.modelScale) || 1),
        sceneScale: entry && entry.display ? entry.display.scale : null
      };
    },
    // 场景执行中的参数值（用于自动化断言，如 Param=30 表示已脱衣）
    paramValues: function(ids) {
      var out = {};
      try {
        var core = this.coreModel();
        (ids || []).forEach(function(key) {
          var idx = resolveParamIndex(core, key);
          out[key] = idx >= 0 ? Number(core.getParamFloat(idx)) : null;
        });
      } catch (e) {
        out.error = String(e);
      }
      return out;
    },
    // SFW 自检：读取当前遮罩状态；setNsfw/setSfw 只影响本次会话，不写入 config.json
    get sfw() { return window.__sfwState || null; },
    setNsfw: function(value) {
      debugNsfwOverride = Boolean(value);
      return applySfwState(appState);
    },
    setSfw: function(value) {
      debugNsfwOverride = !Boolean(value);
      return applySfwState(appState);
    },
    clearSfwOverride: function() {
      debugNsfwOverride = null;
      return applySfwState(appState);
    },
    // SFW 性能自检：测量 requestAnimationFrame 帧率（确认毛玻璃遮罩不明显掉帧）
    fps: function(durationMs) {
      var ms = Math.max(300, Number(durationMs) || 1200);
      return new Promise(function(resolve) {
        var frames = 0;
        var start = performance.now();
        function tick(now) {
          frames += 1;
          var elapsed = now - start;
          if (elapsed >= ms) {
            resolve({
              frames: frames,
              ms: Math.round(elapsed),
              fps: Math.round((frames * 1000 / elapsed) * 10) / 10,
              sfwActive: Boolean(window.__sfwState && window.__sfwState.active)
            });
            return;
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
    }
  };

  boot().catch((error) => {
    root.textContent = `启动失败：${error.message || error}`;
  });
})();
