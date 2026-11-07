const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// ai-control.js 是浏览器 IIFE（挂在 window.PetAiControl 上），用 vm 造一个最小 window 加载纯函数
function loadAiControl() {
  const file = path.join(__dirname, "..", "src", "renderer", "ai-control.js");
  const code = fs.readFileSync(file, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "ai-control.js" });
  return sandbox.window.PetAiControl;
}

const ai = loadAiControl();

// 构造一份「场景/动作/换装/饰品/模型都可用」的能力清单
function fullCaps(overrides) {
  const caps = ai.buildCapabilities({
    modelId: "tachie-ani",
    modelName: "立绘",
    modelEntry: {
      displayName: "立绘",
      display: { scale: 1 },
      aiControl: {
        clothing: { param: "clothes", min: 0, max: 30, dressedValue: 0, nudeValue: 30 },
        accessories: [{ id: "glasses", label: "眼镜", onMotion: "glassON", offMotion: "glassOFF" }],
        motionPrefixes: ["OP_"]
      },
      scenes: [{ id: "idle", label: "待机", category: "日常", description: "普通待机", whenToUse: "默认" }]
    },
    motionMap: { OP_001: { group: "" }, OP_002: { group: "" } },
    models: [{ id: "tachie-ani", name: "立绘" }, { id: "R01_tachie-ani", name: "R01" }],
    catalog: {
      path: "config/scene-catalog.json",
      entries: [{ modelId: "tachie-ani" }, { modelId: "R01_tachie-ani" }]
    },
    sceneAiEnabled: true,
    scale: { percent: 100, min: 25, max: 200, controllable: true }
  });
  return Object.assign(caps, overrides || {});
}

const toolNames = (tools) => tools.map((tool) => tool.function.name);
const findTool = (tools, name) => tools.find((tool) => tool.function.name === name);

test("buildCapabilities 输出 scene_ai_enabled 与 scale（默认开启场景、缩放不可控）", () => {
  const caps = ai.buildCapabilities({ modelId: "m1" });
  assert.equal(caps.scene_ai_enabled, true);
  assert.deepEqual(caps.scale, { percent: 100, min: 25, max: 200, controllable: false });

  const custom = ai.buildCapabilities({
    modelId: "m1",
    sceneAiEnabled: false,
    scale: { percent: 150, min: 25, max: 200, controllable: true }
  });
  assert.equal(custom.scene_ai_enabled, false);
  assert.deepEqual(custom.scale, { percent: 150, min: 25, max: 200, controllable: true });

  // scale.percent 非法时回落到 100，min/max 回落到 25/200
  const fallback = ai.buildCapabilities({ modelId: "m1", scale: { percent: "x" } }).scale;
  assert.equal(fallback.percent, 100);
  assert.equal(fallback.min, 25);
  assert.equal(fallback.max, 200);
  assert.equal(fallback.controllable, false);
});

test("buildTools：scale.controllable=true 时含 set_scale（integer 25~200），false 时没有", () => {
  const controllable = fullCaps();
  const tools = ai.buildTools(controllable);
  const setScale = findTool(tools, "set_scale");
  assert.ok(setScale, "应包含 set_scale");
  assert.equal(setScale.type, "function");
  assert.equal(setScale.function.name, "set_scale");
  const percent = setScale.function.parameters.properties.percent;
  assert.equal(percent.type, "integer");
  assert.equal(percent.minimum, 25);
  assert.equal(percent.maximum, 200);
  assert.deepEqual(setScale.function.parameters.required, ["percent"]);
  assert.equal(setScale.function.parameters.additionalProperties, false);
  // 描述里必须写清「用户要求变大/变小时才调用」
  assert.match(setScale.function.description, /变大/);
  assert.match(setScale.function.description, /变小/);
  assert.match(setScale.function.description, /不要调用/);

  const notControllable = fullCaps({ scale: { percent: 100, min: 25, max: 200, controllable: false } });
  assert.equal(toolNames(ai.buildTools(notControllable)).includes("set_scale"), false);
});

test("buildTools：scene_ai_enabled=false 时不含场景/动作/换装/饰品/模型工具，但保留 set_scale", () => {
  const enabled = toolNames(ai.buildTools(fullCaps()));
  for (const name of ["play_scene", "list_motions", "play_motion", "list_scenes", "set_clothing", "set_accessory", "switch_model"]) {
    assert.ok(enabled.includes(name), "开启时应有 " + name);
  }
  assert.ok(enabled.includes("set_scale"));

  const disabled = ai.buildTools(fullCaps({ scene_ai_enabled: false }));
  assert.deepEqual(toolNames(disabled), ["set_scale"]);

  // 场景与缩放都关闭时返回空数组（main.js 据此不开 function calling）
  const allOff = ai.buildTools(fullCaps({ scene_ai_enabled: false, scale: { controllable: false } }));
  assert.deepEqual(allOff, []);
  // 旧版 caps（无 scene_ai_enabled 字段）按开启处理，保持原有行为
  const legacy = ai.buildTools({ scenes: [{ id: "idle", label: "待机" }] });
  assert.ok(toolNames(legacy).includes("play_scene"));
  assert.deepEqual(ai.buildTools(null), []);
});

test("buildBrief：场景说明受 scene_ai_enabled 控制，缩放说明独立注入", () => {
  // 场景关闭 + 缩放可控制：只输出缩放说明，不出现场景能力介绍
  const scaleOnly = ai.buildBrief(fullCaps({ scene_ai_enabled: false }));
  assert.match(scaleOnly, /桌宠缩放：当前 100%/);
  assert.match(scaleOnly, /set_scale/);
  assert.match(scaleOnly, /25%~200%/);
  assert.match(scaleOnly, /变大\/变小/);
  assert.equal(scaleOnly.includes("当前模型能力"), false);
  assert.equal(scaleOnly.includes("play_scene"), false);

  // 场景开启 + 缩放可控：两段都有
  const both = ai.buildBrief(fullCaps());
  assert.match(both, /当前模型能力/);
  assert.match(both, /play_scene/);
  assert.match(both, /桌宠缩放/);

  // 场景开启 + 缩放不可控：只有场景说明
  const sceneOnly = ai.buildBrief(fullCaps({ scale: { controllable: false } }));
  assert.match(sceneOnly, /当前模型能力/);
  assert.equal(sceneOnly.includes("桌宠缩放"), false);

  // 两者都关闭 / 空值：返回空字符串且不报错
  assert.equal(ai.buildBrief(fullCaps({ scene_ai_enabled: false, scale: { controllable: false } })), "");
  assert.equal(ai.buildBrief(null), "");
  // 旧版 caps（无 scene_ai_enabled 字段）按场景开启处理，不报错
  assert.match(ai.buildBrief({}), /当前模型能力/);
});
