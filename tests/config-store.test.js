const assert = require("node:assert");
const test = require("node:test");
const {
  CHAT_TEXT_MODES,
  DEFAULT_CHAT,
  DEFAULT_CONFIG,
  DEFAULT_HOTKEYS,
  DEFAULT_OVERLAY,
  HOTKEY_ACTIONS,
  MIN_PET_WINDOW,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  mergeConfig
} = require("../src/main/config-store");

test("mergeConfig clamps tiny pet window bounds", () => {
  const config = mergeConfig(
    {
      petWindow: {
        width: 119,
        height: 136,
        x: 1764,
        y: 798
      }
    },
    {}
  );

  assert.equal(config.petWindow.width, MIN_PET_WINDOW.width);
  assert.equal(config.petWindow.height, MIN_PET_WINDOW.height);
  assert.equal(config.petWindow.x, 1764);
  assert.equal(config.petWindow.y, 798);
});

test("SFW 默认开启：nsfwMode 默认 false，只接受布尔值", () => {
  assert.equal(DEFAULT_CONFIG.nsfwMode, false);
  assert.equal(mergeConfig({}, {}).nsfwMode, false);
  // 字符串 "false"/"true" 不应被当成 true（避免配置文件手改后误开 NSFW）
  assert.equal(mergeConfig({ nsfwMode: "true" }, {}).nsfwMode, false);
  assert.equal(mergeConfig({ nsfwMode: "false" }, {}).nsfwMode, false);
  // 用户切到 NSFW 后保持 true
  assert.equal(mergeConfig({ nsfwMode: true }, {}).nsfwMode, true);
  // 切换后持久化值保留（不再提示默认）
  assert.equal(mergeConfig({}, { nsfwMode: true }).nsfwMode, true);
  assert.equal(mergeConfig({ nsfwMode: true }, { nsfwMode: false }).nsfwMode, false);
});

test("sfwBlur 被限制在 8-40px", () => {
  assert.equal(mergeConfig({ sfwBlur: 100 }, {}).sfwBlur, 40);
  assert.equal(mergeConfig({ sfwBlur: 1 }, {}).sfwBlur, 8);
  assert.equal(mergeConfig({}, {}).sfwBlur, 22);
});

test("桌宠缩放限制在 25%~200%，并按 1% 取整", () => {
  assert.equal(PET_SCALE_MIN, 0.25);
  assert.equal(PET_SCALE_MAX, 2);
  assert.equal(mergeConfig({ petScale: 0.01 }, {}).petScale, 0.25);
  assert.equal(mergeConfig({ petScale: 5 }, {}).petScale, 2);
  assert.equal(mergeConfig({ petScale: 0.5 }, {}).petScale, 0.5);
  assert.equal(mergeConfig({}, { petScale: 0.253 } ).petScale, 0.25);
  assert.equal(mergeConfig({}, {}).petScale, 1);
});

test("快捷键动作表与默认键位一一对应，方便 README/管理页共用", () => {
  const actionIds = HOTKEY_ACTIONS.map((item) => item.id).sort();
  const configuredBindings = Object.keys(DEFAULT_HOTKEYS)
    .filter((key) => !["enabled", "step", "fineStep"].includes(key))
    .sort();
  assert.deepEqual(actionIds, configuredBindings);
  // 每个动作都有默认组合键，且不是空串
  for (const id of actionIds) assert.ok(String(DEFAULT_HOTKEYS[id]).includes("+"), id);
  // 包含用户要求的置顶 / SFW / 聊天记录 / 25% 缩放相关动作
  for (const id of ["scaleUp", "scaleDown", "scaleUpFine", "scaleDownFine", "scaleReset", "toggleSfw", "toggleAlwaysOnTop", "toggleChat"]) {
    assert.ok(actionIds.includes(id), id);
  }
});

test("快捷键配置：步进/精细步进钳制，空串表示禁用，非法值回落到默认", () => {
  const hotkeys = mergeConfig({}, {
    hotkeys: {
      step: 999,
      fineStep: 0,
      scaleUp: "  CommandOrControl+Alt+PageUp  ",
      scaleDown: "",
      toggleSfw: 123
    }
  }).hotkeys;

  assert.equal(hotkeys.step, 25);
  assert.equal(hotkeys.fineStep, 1);
  assert.equal(hotkeys.scaleUp, "CommandOrControl+Alt+PageUp");
  assert.equal(hotkeys.scaleDown, "");
  assert.equal(hotkeys.toggleSfw, "");
  // 未提供的键位仍保留默认值
  assert.equal(hotkeys.toggleAlwaysOnTop, DEFAULT_HOTKEYS.toggleAlwaysOnTop);

  assert.equal(mergeConfig({ hotkeys: { enabled: false } }, {}).hotkeys.enabled, false);
  assert.equal(mergeConfig({ hotkeys: { enabled: "false" } }, {}).hotkeys.enabled, true);
});

test("聊天文本模式/气泡/历史上限/持久化 的默认值与钳制", () => {
  assert.deepEqual(CHAT_TEXT_MODES, ["always", "when-tts-off", "off"]);
  assert.equal(DEFAULT_CHAT.textMode, "always");
  assert.equal(DEFAULT_CHAT.persist, true);

  const chat = mergeConfig({}, {
    chat: { textMode: "nope", bubbleMs: 1, historyLimit: 99999, persist: false }
  }).chat;
  assert.equal(chat.textMode, "always");
  assert.equal(chat.bubbleMs, 1500);
  assert.equal(chat.historyLimit, 2000);
  assert.equal(chat.persist, false);

  const chat2 = mergeConfig({}, { chat: { textMode: "when-tts-off", bubbleMs: 999999, historyLimit: 1 } }).chat;
  assert.equal(chat2.textMode, "when-tts-off");
  assert.equal(chat2.bubbleMs, 60000);
  assert.equal(chat2.historyLimit, 20);

  // 老配置文件没有 chat 段时自动补默认值
  assert.equal(mergeConfig({}, {}).chat.textMode, "always");
});

test("聊天悬浮层默认布局存在，AI 缩放开关默认关闭", () => {
  assert.deepEqual(DEFAULT_CONFIG.overlay, {
    locked: false,
    bubble: { mode: "follow", x: 50, y: 18, width: 78 },
    input: { x: 50, y: 92, width: 72 },
    panel: { x: 78, y: 50, width: 84, height: 88 }
  });
  // 老配置文件没有 overlay 段时自动补默认值
  assert.deepEqual(mergeConfig({}, {}).overlay, DEFAULT_CONFIG.overlay);
  assert.deepEqual(DEFAULT_OVERLAY.bubble, { mode: "follow", x: 50, y: 18, width: 78 });

  // AI 缩放默认关闭，且只接受布尔值
  assert.equal(DEFAULT_CONFIG.aiControl.scaleEnabled, false);
  assert.equal(mergeConfig({}, {}).aiControl.scaleEnabled, false);
  assert.equal(mergeConfig({ aiControl: { scaleEnabled: "true" } }, {}).aiControl.scaleEnabled, false);
  assert.equal(mergeConfig({}, { aiControl: { scaleEnabled: true } }).aiControl.scaleEnabled, true);
});

test("聊天悬浮层部分 patch 合并不丢其它字段，且不污染默认值", () => {
  const config = mergeConfig(
    { overlay: { bubble: { x: 30 }, panel: { height: 60 } } },
    { overlay: { input: { y: 80 } } }
  );
  // 被 patch 的字段生效
  assert.equal(config.overlay.bubble.x, 30);
  assert.equal(config.overlay.panel.height, 60);
  assert.equal(config.overlay.input.y, 80);
  // 未被 patch 的字段保留默认值（不因只传子对象而丢失）
  assert.equal(config.overlay.bubble.mode, "follow");
  assert.equal(config.overlay.bubble.width, 78);
  assert.equal(config.overlay.panel.x, 78);
  assert.equal(config.overlay.input.x, 50);
  assert.equal(config.overlay.locked, false);
  // 合并结果与默认对象相互独立：改结果不会改到 DEFAULT_OVERLAY
  config.overlay.bubble.x = 99;
  assert.equal(DEFAULT_OVERLAY.bubble.x, 50);
});

test("聊天悬浮层坐标/尺寸越界被 clamp，mode 非法回退 follow", () => {
  const config = mergeConfig({}, {
    overlay: {
      locked: "yes",
      bubble: { mode: "absolute", x: -20, y: 140, width: 5 },
      input: { x: 130, y: -5, width: 500 },
      panel: { x: 10, y: 110, width: 100, height: 10 }
    }
  }).overlay;

  assert.equal(config.locked, false); // 非布尔 true 视为未锁定
  assert.equal(config.bubble.mode, "follow"); // 非法 mode 回退
  assert.equal(config.bubble.x, 0);
  assert.equal(config.bubble.y, 100);
  assert.equal(config.bubble.width, 25);
  assert.equal(config.input.x, 100);
  assert.equal(config.input.y, 0);
  assert.equal(config.input.width, 96);
  assert.equal(config.panel.x, 10);
  assert.equal(config.panel.y, 100);
  assert.equal(config.panel.width, 96);
  assert.equal(config.panel.height, 35);

  // 合法 manual / locked=true / 两位小数 保留
  const manual = mergeConfig({}, {
    overlay: { locked: true, bubble: { mode: "manual", x: 33.33, y: 12.5 }, panel: { height: 96 } }
  }).overlay;
  assert.equal(manual.locked, true);
  assert.equal(manual.bubble.mode, "manual");
  assert.equal(manual.bubble.x, 33.33);
  assert.equal(manual.bubble.y, 12.5);
  assert.equal(manual.panel.height, 96);

  // 非法数值（null/字符串）回落到默认值，而不是被当成 0
  const fallback = mergeConfig({ overlay: { bubble: { x: null, y: "abc" } } }, {}).overlay;
  assert.equal(fallback.bubble.x, 50);
  assert.equal(fallback.bubble.y, 18);
});
