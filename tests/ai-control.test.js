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
    models: [
      { id: "tachie-ani", name: "初冬暖阳R · tachie_ani", displayName: "tachie_ani", game: "初冬暖阳R", modelDirName: "tachie_ani", selected: true },
      { id: "lib-tyrano-13cmx1o", name: "初冬暖阳R · k04_kijoui_ani", displayName: "k04_kijoui_ani", game: "初冬暖阳R", modelDirName: "k04_kijoui_ani", kind: "character", nsfwOnly: true, sceneLabel: "骑乘位场景（騎乗位）", description: "亲密行为场景模型：骑乘位（騎乗位）动画", keywords: ["骑乘", "骑乘位"] },
      { id: "lib-tyrano-120nbqr", name: "初冬暖阳R · k03_tekoki_ani", displayName: "k03_tekoki_ani", game: "初冬暖阳R", modelDirName: "k03_tekoki_ani", kind: "character", nsfwOnly: true, sceneLabel: "手交场景（手コキ）", description: "亲密行为场景模型：手交（手コキ）特写动画", keywords: ["手交"] },
      { id: "R01_tachie-ani", name: "处女前辈 · R01_tachie_ani", displayName: "R01_tachie_ani", game: "处女前辈", modelDirName: "R01_tachie_ani", kind: "character" }
    ],
    previousModel: { id: "R01_tachie-ani", name: "处女前辈 · R01_tachie_ani", displayName: "R01_tachie_ani" },
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

test("buildTools：switch_model 支持 id/名称/上一个，list_models 可搜索", () => {
  const tools = ai.buildTools(fullCaps());
  const list = findTool(tools, "list_models");
  assert.ok(list, "应包含 list_models");
  assert.deepEqual(Object.keys(list.function.parameters.properties).sort(), ["game", "limit", "query"]);

  const sw = findTool(tools, "switch_model");
  assert.ok(sw, "应包含 switch_model");
  const props = sw.function.parameters.properties;
  assert.ok(props.model_id, "应有 model_id");
  assert.ok(props.model_name, "应有 model_name（用户常说模型名，只有 id 无法映射）");
  assert.ok(props.previous, "应有 previous（换回上一个）");
  assert.equal(sw.function.parameters.required, undefined);
  // 描述里要带上当前/上一个模型，AI 才知道“换回去”指谁
  assert.match(sw.function.description, /tachie_ani/);
  assert.match(sw.function.description, /R01_tachie_ani/);
  assert.match(sw.function.description, /换回上一个/);
});

test("buildBrief：包含模型名→id 目录与上一个模型", () => {
  const brief = ai.buildBrief(fullCaps());
  assert.match(brief, /模型切换/);
  assert.match(brief, /k04_kijoui_ani=lib-tyrano-13cmx1o/);
  assert.match(brief, /上一个模型：R01_tachie_ani/);
  assert.match(brief, /list_models/);
  // 场景关闭时不注入模型切换说明（避免关闭后仍引导调用工具）
  const off = ai.buildBrief(fullCaps({ scene_ai_enabled: false, scale: { controllable: false } }));
  assert.equal(off.includes("模型切换"), false);
});

test("resolveModelTarget：id/显示名/关键字/上一下都能解析，歧义给出候选", () => {
  const caps = fullCaps();
  const models = caps.models;

  const byId = ai.resolveModelTarget(models, { model_id: "lib-tyrano-13cmx1o" }, caps.previous_model);
  assert.equal(byId.ok, true);
  assert.equal(byId.model.id, "lib-tyrano-13cmx1o");

  const byDisplay = ai.resolveModelTarget(models, { model_name: "k04_kijoui_ani" }, caps.previous_model);
  assert.equal(byDisplay.ok, true);
  assert.equal(byDisplay.model.id, "lib-tyrano-13cmx1o");

  const byDir = ai.resolveModelTarget(models, { model_name: "R01_tachie_ani" }, caps.previous_model);
  assert.equal(byDir.ok, true);
  assert.equal(byDir.model.id, "R01_tachie-ani");

  // “上一个”优先于别的参数
  const prev = ai.resolveModelTarget(models, { previous: true, model_name: "k04" }, caps.previous_model);
  assert.equal(prev.ok, true);
  assert.equal(prev.model.id, "R01_tachie-ani");
  assert.equal(prev.matchedBy, "previous");

  const noPrev = ai.resolveModelTarget(models, { previous: true }, null);
  assert.equal(noPrev.ok, false);
  assert.equal(noPrev.reason, "no_previous");

  // 关键字命中“骑乘”这类场景说法时，调用方也可先带 model_name
  const byGame = ai.resolveModelTarget(models, { model_name: "处女前辈" }, caps.previous_model);
  assert.equal(byGame.ok, true);
  assert.equal(byGame.model.id, "R01_tachie-ani");

  // tachie_ani 只命中一个（精确显示名），不会因为 R01 而歧义
  const exact = ai.resolveModelTarget(models, { model_name: "tachie_ani" }, caps.previous_model);
  assert.equal(exact.ok, true);
  assert.equal(exact.model.id, "tachie-ani");

  const notFound = ai.resolveModelTarget(models, { model_name: "不存在的模型" }, caps.previous_model);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, "not_found");

  const empty = ai.resolveModelTarget(models, {}, caps.previous_model);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "missing_target");
});

test("resolveModelTarget：按场景语义/姿势理解用户意思（不用报文件名）", () => {
  const caps = fullCaps();
  const models = caps.models;
  const bySemantic = ai.resolveModelTarget(models, { model_name: "骑乘位" }, null);
  assert.equal(bySemantic.ok, true);
  assert.equal(bySemantic.model.id, "lib-tyrano-13cmx1o");
  const byKeyword = ai.resolveModelTarget(models, { model_name: "手交" }, null);
  assert.equal(byKeyword.ok, true);
  assert.equal(byKeyword.model.id, "lib-tyrano-120nbqr");
  // 语义标签也可以直接作为精确别名
  const bySceneLabel = ai.resolveModelTarget(models, { model_name: "骑乘位场景（騎乗位）" }, null);
  assert.equal(bySceneLabel.ok, true);
  assert.equal(bySceneLabel.model.id, "lib-tyrano-13cmx1o");
});

test("resolveModelTarget：多个同分候选返回 ambiguous 与候选列表", () => {
  const models = [
    { id: "a1", name: "游戏A · k01", display_name: "k01", game: "游戏A" },
    { id: "a2", name: "游戏A · k02", display_name: "k02", game: "游戏A" },
    { id: "b1", name: "游戏B · x01", display_name: "x01", game: "游戏B" }
  ];
  const result = ai.resolveModelTarget(models, { model_name: "游戏A" }, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((item) => item.id).sort(), ["a1", "a2"]);
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
