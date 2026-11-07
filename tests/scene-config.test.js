const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  loadScenesConfig,
  normalizeScenesConfig,
  getModelScenes,
  parseSceneTags,
  stripSceneTags,
  matchSceneByText,
  buildScenePrompt,
  buildSystemPrompt,
  findScene
} = require("../src/main/scene-config");

const SCENES_FILE = path.join(__dirname, "..", "config", "scenes.json");

test("scenes.json 可加载且两模型场景数量满足要求", () => {
  const { config, error } = loadScenesConfig(SCENES_FILE);
  assert.equal(error, null);
  for (const modelId of ["tachie-ani", "r01-tachie-ani"]) {
    const info = getModelScenes(config, modelId);
    assert.equal(info.fallback, false);
    assert.ok(info.scenes.length >= 8 && info.scenes.length <= 15, `${modelId} 场景数 ${info.scenes.length}`);
    const ids = info.scenes.map((scene) => scene.id);
    assert.equal(new Set(ids).size, ids.length, "场景 id 不能重复");
    for (const scene of info.scenes) {
      assert.ok(scene.label, `${scene.id} 缺少 label`);
      assert.ok(["换装", "亲密", "情绪", "日常", "实验性", "其他"].includes(scene.category));
      assert.ok(Array.isArray(scene.keywords));
      assert.ok(Array.isArray(scene.motions));
    }
  }
});

test("tachie 的脱衣场景使用 Param 0→30 且带证据", () => {
  const { config } = loadScenesConfig(SCENES_FILE);
  const tachie = getModelScenes(config, "tachie-ani");
  const undress = findScene(tachie.scenes, "undress");
  assert.ok(undress);
  assert.equal(undress.category, "换装");
  assert.equal(undress.params.Param, 30);
  assert.equal(undress.persistent, true);
  assert.equal(undress.evidence.param, "Param");
  const dress = findScene(tachie.scenes, "dress");
  assert.equal(dress.params.Param, 0);
  const half = findScene(tachie.scenes, "half_undress");
  assert.equal(half.params.Param, 15);
  // task-13：半脱是启发式参数插值，必须带实验性标记并归入「实验性」分类（默认不自动触发）
  assert.equal(half.category, "实验性");
  assert.equal(half.experimental, true);
  assert.equal(half.heuristic, true);
  assert.ok(String(half.heuristicNote || "").includes("启发式"));
  assert.equal(tachie.capabilities.undress.supported, true);
});

test("R01 明确不支持脱衣、眼镜穿脱用 Param30", () => {
  const { config } = loadScenesConfig(SCENES_FILE);
  const r01 = getModelScenes(config, "r01-tachie-ani");
  assert.equal(r01.capabilities.undress.supported, false);
  assert.equal(r01.display.scale, 1.0);
  const on = findScene(r01.scenes, "glasses_on");
  const off = findScene(r01.scenes, "glasses_off");
  assert.equal(on.params.Param30, 0);
  assert.equal(off.params.Param30, 30);
});

test("未知模型返回 fallback 且不抛错", () => {
  const { config } = loadScenesConfig(SCENES_FILE);
  const info = getModelScenes(config, "no-such-model");
  assert.equal(info.fallback, true);
  assert.deepEqual(info.scenes, []);
});

test("场景标签解析：中英括号、剥离、去重", () => {
  const parsed = parseSceneTags("好呀[scene:shy] 那就这样[scene:undress]");
  assert.deepEqual(parsed.sceneIds, ["shy", "undress"]);
  assert.equal(parsed.text, "好呀 那就这样");
  const cn = parseSceneTags("嗯嗯【scene:mood_happy】");
  assert.deepEqual(cn.sceneIds, ["mood_happy"]);
  assert.equal(cn.text, "嗯嗯");
  assert.equal(stripSceneTags("hello [scene:x] world"), "hello world");
  assert.equal(stripSceneTags("没有标签"), "没有标签");
});

test("标签大小写不敏感、非法标签不误伤", () => {
  const parsed = parseSceneTags("[SCENE:Undress]");
  assert.deepEqual(parsed.sceneIds, ["undress"]);
  assert.equal(parseSceneTags("[scene:]").sceneIds.length, 0);
  assert.equal(parseSceneTags("普通[括号]内容").sceneIds.length, 0);
});

test("关键词匹配优先级：换装 > 情绪 > 日常", () => {
  const { config } = loadScenesConfig(SCENES_FILE);
  const tachie = getModelScenes(config, "tachie-ani");
  const clothing = matchSceneByText(tachie.scenes, "我想看你脱衣服");
  assert.equal(clothing.scene.id, "undress");
  const emotion = matchSceneByText(tachie.scenes, "今天好开心呀");
  assert.equal(emotion.scene.id, "mood_happy");
  const daily = matchSceneByText(tachie.scenes, "晚安，好好睡");
  assert.equal(daily.scene.id, "daily_goodnight");
});

test("日文关键词匹配与排除场景", () => {
  const { config } = loadScenesConfig(SCENES_FILE);
  const r01 = getModelScenes(config, "r01-tachie-ani");
  const match = matchSceneByText(r01.scenes, "メガネを外して");
  assert.equal(match.scene.id, "glasses_off");
  const excluded = matchSceneByText(r01.scenes, "メガネを外して", { excludeId: "glasses_off" });
  assert.notEqual(excluded && excluded.scene.id, "glasses_off");
});

test("AI 提示词包含场景标签与模型场景", () => {
  const { config } = loadScenesConfig(SCENES_FILE);
  const prompt = buildScenePrompt(config, "tachie-ani");
  assert.ok(prompt.includes("[scene:daily_hello]"));
  assert.ok(prompt.includes("脱衣服"));
  assert.ok(prompt.includes("换装"));
  const systemPrompt = buildSystemPrompt("你是呆呆", config, "tachie-ani");
  assert.ok(systemPrompt.startsWith("你是呆呆"));
  assert.ok(systemPrompt.includes("动作/场景控制协议"));
});

test("normalizeScenesConfig 处理脏数据", () => {
  const cfg = normalizeScenesConfig({ models: { m: { scenes: [{ id: "a", label: "A", category: "乱写", params: { Param: "15" } }] } } });
  const scene = cfg.models.m.scenes[0];
  assert.equal(scene.category, "其他");
  assert.equal(scene.params.Param, 15);
  assert.equal(scene.persistent, true);
  assert.deepEqual(normalizeScenesConfig(null).models, {});
});
