const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("daidaiPet", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  setConfig: (patch) => ipcRenderer.invoke("app:set-config", patch),  importModelDirectory: () => ipcRenderer.invoke("model:import-directory"),
  selectModel: (modelId) => ipcRenderer.invoke("model:select", modelId),
  openModelsDirectory: () => ipcRenderer.invoke("model:open-directory"),
  openSoundsDirectory: () => ipcRenderer.invoke("model:open-sounds-directory"),
  showPet: () => ipcRenderer.invoke("pet:show"),
  hidePet: () => ipcRenderer.invoke("pet:hide"),
  // 桌宠改造：手动拖拽窗口（替代 -webkit-app-region: drag，保留鼠标点击互动能力）
  moveWindow: (pos) => ipcRenderer.invoke("pet:move-window", pos),
  // 桌宠改造：把宠物窗口自身画面（带透明通道）截存成 PNG，用于自检/留档
  capturePet: (filePath) => ipcRenderer.invoke("pet:capture-page", filePath),
  onUpdate: (callback) => subscribe("app:update", callback),
  onCursorPosition: (callback) => subscribe("pet:cursor-position", callback),
  onDragState: (callback) => subscribe("pet:drag-state", callback),
  tavernChat: (messages) => ipcRenderer.invoke("tavern:chat", messages),
  tavernTts: (text) => ipcRenderer.invoke("tavern:tts", text),
  tavernCleanup: () => ipcRenderer.invoke("tavern:cleanup"),
  tavernFocusWindow: () => ipcRenderer.invoke("tavern:focus-window"),
  tavernAbort: () => ipcRenderer.invoke("tavern:abort"),
  // 角色卡：每个角色一张提示词（角色 → 模型 → 场景 → 动作）
  setCharacterPrompt: (id, prompt) => ipcRenderer.invoke("characters:set-prompt", { id, prompt }),
  resetCharacterPrompt: (id) => ipcRenderer.invoke("characters:set-prompt", { id, reset: true }),
  getActiveCharacter: () => ipcRenderer.invoke("characters:get-active"),
  // 场景系统：面板/托盘触发场景、宠物窗回报执行状态
  playScene: (sceneId) => ipcRenderer.invoke("scene:play", { id: sceneId, source: "panel" }),
  resetSceneState: () => ipcRenderer.invoke("scene:reset", { source: "panel" }),
  openScenesConfig: () => ipcRenderer.invoke("scene:open-config"),
  reloadScenesConfig: () => ipcRenderer.invoke("scene:reload"),
  closeScenesPanel: () => ipcRenderer.invoke("scene:close-panel"),
  reportSceneState: (state) => ipcRenderer.invoke("scene:state", state),
  onSceneCommand: (callback) => subscribe("pet:scene-command", callback),
  onSceneState: (callback) => subscribe("pet:scene-state", callback),
  // AI function calling：主进程转发工具调用到渲染进程执行，执行结果回传
  onToolCall: (callback) => subscribe("pet:tool-call", callback),
  reportToolResult: (requestId, result) => ipcRenderer.invoke("pet:tool-result", { requestId, result }),
  reportCapabilities: (capabilities) => ipcRenderer.invoke("pet:capabilities", capabilities),
  reportRendererError: (payload) => ipcRenderer.invoke("app:renderer-error", payload),
  // 模型库：重新扫描 63 个模型 + 打开每模型显示/隐藏部件配置
  rescanModels: () => ipcRenderer.invoke("model:rescan"),
  openModelDisplayConfig: () => ipcRenderer.invoke("model:open-display-config"),
  openGeneratedScenes: () => ipcRenderer.invoke("model:open-generated-scenes"),
  // 场景目录：一个模型 = 一个可切换场景（含描述/whenToUse/NSFW 限制）
  playCatalogScene: (modelId, sceneId) => ipcRenderer.invoke("scene:play-catalog", { modelId, sceneId: sceneId || "" }),
  // 管理页缩放兜底（manager-guard.js 调用）：恢复 100% 页面缩放
  resetManagerZoom: () => ipcRenderer.invoke("app:reset-manager-zoom"),
  onCatalogScene: (callback) => subscribe("pet:catalog-scene", callback),
  // 桌宠缩放（25%~200%，1% 粒度）
  setPetScale: (scale) => ipcRenderer.invoke("pet:set-scale", scale),
  getPetScale: () => ipcRenderer.invoke("pet:get-scale"),
  fitPetScale: () => ipcRenderer.invoke("pet:fit-scale"),
  onPetResize: (callback) => subscribe("pet:resize", callback),
  // 全局快捷键：状态查询/重新注册（注册失败原因会显示在管理页）
  getHotkeyStatus: () => ipcRenderer.invoke("hotkeys:status"),
  refreshHotkeys: () => ipcRenderer.invoke("hotkeys:refresh"),
  // 录制组合键：主进程 before-input-event 拼 accelerator，返回 {ok, accelerator}
  recordHotkey: () => ipcRenderer.invoke("hotkeys:record"),
  // 聊天记录：文本模式的持久化历史（按角色隔离）
  loadChatHistory: (characterId) => ipcRenderer.invoke("chat:history-load", characterId),
  appendChatHistory: (payload) => ipcRenderer.invoke("chat:history-append", payload),
  clearChatHistory: (characterId) => ipcRenderer.invoke("chat:history-clear", characterId),
  openChatPanel: () => ipcRenderer.invoke("chat:open-panel"),
  // 主进程快捷键触发：打开/关闭聊天面板 + 聚焦输入框
  onToggleChat: (callback) => subscribe("pet:toggle-chat", callback),
  onFocusChat: (callback) => subscribe("pet:focus-chat", callback)
});

// 调试钩子：仅在主进程以 DAIDAI_DEBUG_HOOKS=1 / --debug-hooks 启动时可用，
// 用于自动化截图（例如弹出托盘菜单核对 SFW 开关位置）。普通运行调用会失败，无副作用。
contextBridge.exposeInMainWorld("daidaiDebug", {
  showTrayMenu: () => ipcRenderer.invoke("app:debug-show-tray-menu"),
  traySnapshot: () => ipcRenderer.invoke("app:debug-tray-snapshot"),
  trayToggleSfw: () => ipcRenderer.invoke("app:debug-tray-toggle-sfw"),
  showManager: () => ipcRenderer.invoke("app:debug-show-manager"),
  hideManager: () => ipcRenderer.invoke("app:debug-hide-manager"),
  showScenePanel: () => ipcRenderer.invoke("app:debug-open-scene-panel"),
  sceneInfo: () => ipcRenderer.invoke("app:debug-scene-info"),
  trayScene: (sceneId) => ipcRenderer.invoke("app:debug-tray-scene", sceneId),
  capabilities: () => ipcRenderer.invoke("app:debug-capabilities"),
  aiState: () => ipcRenderer.invoke("app:debug-ai-state"),
  setPetWindowBounds: (bounds) => ipcRenderer.invoke("app:debug-set-pet-bounds", bounds),
  petBounds: () => ipcRenderer.invoke("app:debug-pet-bounds"),
  catalogAudit: () => ipcRenderer.invoke("app:debug-catalog-audit"),
  startupGuard: () => ipcRenderer.invoke("app:debug-startup-guard"),
  catalogEntry: (modelId) => ipcRenderer.invoke("app:debug-catalog-entry", modelId),
  scenePool: () => ipcRenderer.invoke("app:debug-scene-pool"),
  applyScale: (scale) => ipcRenderer.invoke("app:debug-scale-apply", scale),
  fitScale: () => ipcRenderer.invoke("app:debug-scale-fit"),
  // 托盘「🔍 缩放」子菜单：快照 + 点击真实菜单项（验证托盘入口与其它入口一致）
  zoomMenu: () => ipcRenderer.invoke("app:debug-zoom-menu"),
  trayZoom: (label) => ipcRenderer.invoke("app:debug-tray-zoom", label),
  setMainNsfw: (value) => ipcRenderer.invoke("app:debug-set-main-nsfw", value === null ? null : Boolean(value)),
  captureAlpha: (filePath) => ipcRenderer.invoke("app:debug-capture-alpha", filePath),
  setScaleBase: (base) => ipcRenderer.invoke("app:debug-set-scale-base", base),
  activeCharacter: () => ipcRenderer.invoke("app:debug-active-character"),
  // 全局快捷键 / 聊天历史自动化验证
  hotkeys: () => ipcRenderer.invoke("app:debug-hotkeys"),
  triggerHotkey: (id) => ipcRenderer.invoke("app:debug-trigger-hotkey", id),
  chatHistory: (characterId) => ipcRenderer.invoke("app:debug-chat-history", characterId)
});
