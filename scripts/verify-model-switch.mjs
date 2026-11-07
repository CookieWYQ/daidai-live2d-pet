// 端到端验证：聊天里让 AI 切换模型、再「换回去」，以及名称模糊匹配/歧义提示。
// 依赖：Electron 以 --remote-debugging-port=9333 + DAIDAI_DEBUG_HOOKS=1 启动（使用隔离测试数据目录）
// 用法：node scripts/verify-model-switch.mjs --port=9333 --out=../screenshots/model-switch
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(argOf("port", 9333));
const OUT = path.resolve(argOf("out", path.join(process.cwd(), "..", "screenshots", "model-switch")));
const MOCK_PORT = Number(argOf("mock-port", 18908));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`);
}

async function listTargets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0; const pending = new Map();
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("ws")), { once: true }); });
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (o.exceptionDetails) throw new Error(o.exceptionDetails.text + " " + (o.exceptionDetails.exception?.description || ""));
    return o.result.value;
  };
  const screenshot = async (file) => { const s = await send("Page.captureScreenshot", { format: "png", fromSurface: true }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(s.data, "base64")); return file; };
  return { send, evaluate, screenshot, close: () => ws.close() };
}

// mock LLM：第一次返回 switch_model（按用户话决定目标），收到工具结果后返回一句自然语言
function startMockLlm() {
  let callSeq = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const hasToolResult = messages.some((m) => m.role === "tool");
      let message;
      if (!hasToolResult) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const text = lastUser ? String(lastUser.content || "") : "";
        if (/记录面板测试/.test(text)) {
          message = { role: "assistant", content: "记录面板也能聊天啦" };
        } else {
          let argsObj;
          if (/换回去|切回|上一个/.test(text)) argsObj = { previous: true };
          else if (/m02/i.test(text)) argsObj = { model_name: "M02_tachie_ani" };
          else argsObj = { model_name: "Midori" };
          message = {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_switch_" + (++callSeq), type: "function", function: { name: "switch_model", arguments: JSON.stringify(argsObj) } }]
          };
        }
      } else {
        message = { role: "assistant", content: "好呀，已经换好啦～" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "mock", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await fn()) return true; } catch {}
    await sleep(180);
  }
  console.log("TIMEOUT waiting for:", label || "");
  return false;
}

async function main() {
  const targets = await listTargets();
  const petT = targets.find((t) => t.type === "page" && t.url.includes("view=pet"));
  if (!petT) throw new Error("找不到宠物窗 target（调试端口是否开着？）");
  const pet = await connect(petT.webSocketDebuggerUrl);

  const selection = () => pet.evaluate(`window.__petDebug.selection()`);
  const capsNow = () => pet.evaluate(`(() => { const c = window.__petDebug.getCapabilities(); return { modelId: c && c.model_id, tools: c && c.tools ? c.tools.map(t => t.function && t.function.name) : [], models: c && c.models ? c.models.length : 0, prev: c && c.previous_model ? c.previous_model.id : null, brief: c && c.brief ? c.brief : "" }; })()`);
  const aiState = () => pet.evaluate(`window.daidaiDebug.aiState()`);

  const before = await selection();
  const originalModelId = before.selectedModelId;
  console.log("original model:", originalModelId, before.selectedModelName, "sfw:", before.sfw);
  if (!originalModelId) throw new Error("拿不到当前选中的模型 id");

  const targetModelId = "lib-tyrano-11xfcbq"; // M02_tachie_ani（非 NSFW，SFW 测试用）
  try {
    // 测试纪律：始终 SFW(NSFW 关)、强模糊、声音关（用户要求测试画面不可辨认）
    await pet.evaluate(`window.daidaiPet.setConfig({ nsfwMode: false, sfwBlur: 72, soundEnabled: false })`);
    await sleep(1200);
    const sfw0 = await pet.evaluate(`({ sfw: window.__sfwState, audio: window.__petDebug.audioState() })`);
    record("测试环境：SFW 已开启且模糊强度≥30px", Boolean(sfw0.sfw && sfw0.sfw.active && sfw0.sfw.blur >= 30), sfw0.sfw);
    record("测试环境：声音已关闭", Boolean(sfw0.audio && sfw0.audio.soundEnabled === false), sfw0.audio);

    const ready = await waitFor(async () => {
      const sel = await selection();
      const caps = await capsNow();
      return caps.modelId === sel.selectedModelId && caps.tools.includes("switch_model") && caps.tools.includes("list_models");
    }, 25000, "capabilities ready");
    record("能力清单就绪且包含 switch_model / list_models", ready, await aiState());

    const caps0 = await capsNow();
    record("模型目录含用户可见名称（k04_kijoui_ani）", /k04_kijoui_ani=lib-tyrano-13cmx1o/.test(caps0.brief || ""), { models: caps0.models, prev: caps0.prev });

    const mock = await startMockLlm();
    try {
      await pet.evaluate(`window.daidaiPet.setConfig({ tavern: { textBaseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1', textApiKey: 'mock-key', textModel: 'mock', ttsToken: '' } })`);
      await sleep(500);

      // ---- 1. 聊天里按名称切换模型 ----
      await pet.evaluate(`window.__sendTavernMessage ? window.__sendTavernMessage('换成 M02_tachie_ani 那个模型') : false`);
      const switched = await waitFor(async () => (await selection()).selectedModelId === targetModelId, 25000, "switch by name");
      const loaded = await waitFor(async () => (await selection()).loadedModelId === targetModelId, 20000, "model loaded");
      const after = await selection();
      const log1 = await pet.evaluate(`window.__petDebug.toolLog()`);
      const swLog = (log1 || []).filter((item) => item && item.name === "switch_model").pop();
      record("聊天按模型名切换：selectedModelId 已变", Boolean(switched), { from: originalModelId, to: after.selectedModelId, tool: swLog && swLog.result });
      record("切换后新模型确实加载完成", Boolean(loaded), { loadedModelId: after.loadedModelId });
      record("切换后记录上一个模型", Boolean(after.previousModelId === originalModelId), { previous: after.previousModelId, name: after.previousModelName });
      await pet.screenshot(`${OUT}/pet_switch_sfw.png`);

      // 能力清单刷新为新模型，且 brief 带「上一个模型」
      const caps1 = await capsNow();
      record("切换后能力清单已刷新为新模型", caps1.modelId === targetModelId, { capsModel: caps1.modelId, expected: targetModelId });
      record("新能力清单 brief 含上一个模型", /上一个模型：/.test(caps1.brief || ""), { prev: caps1.prev });

      // ---- 2. 聊天里「换回去」→ previous ----
      await pet.evaluate(`window.__sendTavernMessage ? window.__sendTavernMessage('换回上一个模型') : false`);
      const back = await waitFor(async () => (await selection()).selectedModelId === originalModelId, 25000, "switch previous");
      const backLoaded = await waitFor(async () => (await selection()).loadedModelId === originalModelId, 20000, "back model loaded");
      const log2 = await pet.evaluate(`window.__petDebug.toolLog()`);
      const prevLog = (log2 || []).filter((item) => item && item.name === "switch_model" && item.args && item.args.previous === true).pop();
      const backState = await selection();
      record("聊天「换回去」按 previous 切回原模型", Boolean(back), { selectedModelId: backState.selectedModelId, tool: prevLog && prevLog.result });
      record("切回后原模型加载完成", Boolean(backLoaded), { loadedModelId: backState.loadedModelId });
      record("切回后 previous 变成刚才的 M02", Boolean(backState.previousModelId === targetModelId), { previous: backState.previousModelId, name: backState.previousModelName });
      await pet.screenshot(`${OUT}/pet_switch_back_sfw.png`);

      // ---- 3. list_models 搜索 ----
      const listRes = await pet.evaluate(`window.__petDebug.simulateToolCall('list_models', { query: 'k04' })`);
      record("list_models(query=k04) 能返回目标模型", Boolean(listRes && listRes.ok && listRes.models.some((m) => m.id === "lib-tyrano-13cmx1o")), listRes);

      // ---- 4. 只说游戏名：返回歧义候选，而不是乱切 ----
      const ambiguous = await pet.evaluate(`window.__petDebug.simulateToolCall('switch_model', { model_name: '初冬暖阳R' })`);
      record("只说游戏名不误切，返回 ambiguous+候选", Boolean(ambiguous && ambiguous.ok === false && ambiguous.reason === "ambiguous" && ambiguous.candidates.length >= 2), ambiguous);
      const still = await selection();
      record("歧义时当前模型保持不变", still.selectedModelId === originalModelId, { selectedModelId: still.selectedModelId });

      // ---- 5. SFW 纪律：NSFW 场景模型必须被拦截 ----
      const sfwBlocked = await pet.evaluate(`window.__petDebug.simulateToolCall('switch_model', { model_name: 'k04_kijoui_ani' })`);
      const sfwState = await selection();
      record("SFW 下切换 NSFW 场景模型被拒绝（不会切）", Boolean(sfwBlocked && sfwBlocked.ok === false && sfwBlocked.reason === "nsfw_required" && sfwState.selectedModelId === originalModelId), { res: sfwBlocked, selected: sfwState.selectedModelId });

      // ---- 6. 语义搜索：用户描述场景，list_models 能返回对应模型 ----
      const listSemantic = await pet.evaluate(`window.__petDebug.simulateToolCall('list_models', { query: '骑乘' })`);
      const hit = listSemantic && listSemantic.models && listSemantic.models.find((m) => m.id === "lib-tyrano-13cmx1o");
      record("list_models 语义搜索（骑乘）能返回对应模型", Boolean(listSemantic && listSemantic.ok && hit && /骑乘/.test(hit.scene_label || "")), { total: listSemantic && listSemantic.total, hit });

      // ---- 8. 「记录」按钮 + 聊天面板内直接对话 ----
      await pet.evaluate(`(() => { const b = document.getElementById('tavern-history'); if (b) b.click(); return true; })()`);
      await sleep(800);
      const panelUi = await pet.evaluate(`(() => {
        const panel = document.getElementById('chat-panel');
        const input = document.getElementById('chat-panel-input');
        const send = document.getElementById('chat-panel-send');
        return { open: Boolean(panel && panel.classList.contains('open')), hasInput: Boolean(input), hasSend: Boolean(send), placeholder: input && input.placeholder };
      })()`);
      record("输入框旁「记录」按钮能打开面板，且面板内有聊天输入", Boolean(panelUi.open && panelUi.hasInput && panelUi.hasSend), panelUi);
      const listBefore = await pet.evaluate(`document.querySelectorAll('#chat-panel-list .chat-msg').length`);
      await pet.evaluate(`(() => {
        const input = document.getElementById('chat-panel-input');
        input.value = '记录面板测试';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`);
      const panelReplied = await waitFor(async () => {
        const text = await pet.evaluate(`document.getElementById('chat-panel-list') ? document.getElementById('chat-panel-list').innerText : ''`);
        return String(text || "").indexOf("记录面板也能聊天啦") !== -1;
      }, 25000, "panel chat reply");
      const listAfter = await pet.evaluate(`document.querySelectorAll('#chat-panel-list .chat-msg').length`);
      record("在聊天记录面板内直接发消息并收到回复", Boolean(panelReplied && listAfter >= listBefore + 2), { listBefore, listAfter });
      await pet.screenshot(`${OUT}/pet_history_panel_sfw.png`);
      await pet.evaluate(`(() => { const b = document.getElementById('chat-panel-close'); if (b) b.click(); return true; })()`);
      await sleep(400);

      // ---- 9. 按 id 精确切换（非 NSFW 模型），再 previous 切回 ----
      const byId = await pet.evaluate(`window.__petDebug.simulateToolCall('switch_model', { model_id: 'lib-ffhouse-1avyyun' })`);
      const byIdState = await selection();
      record("按 model_id 精确切换 Midori 成功", Boolean(byId && byId.ok && byIdState.selectedModelId === "lib-ffhouse-1avyyun" && byId.loaded), { res: byId, selected: byIdState.selectedModelId });
      await sleep(500);
      const backById = await pet.evaluate(`window.__petDebug.simulateToolCall('switch_model', { previous: true })`);
      const backByIdState = await selection();
      record("按 id 切换后可 previous 切回", Boolean(backById && backById.ok && backByIdState.selectedModelId === originalModelId), { res: backById, selected: backByIdState.selectedModelId });
    } finally {
      mock.close();
    }
  } finally {
    // 测试数据目录是副本，只把选中模型恢复回测试起点，避免截图/后续验证受干扰
    try {
      await pet.evaluate(`window.daidaiPet.selectModel(${JSON.stringify(originalModelId)})`);
      await sleep(1200);
      const st = await selection();
      record("恢复测试起点模型", st.selectedModelId === originalModelId, { selectedModelId: st.selectedModelId });
    } catch (e) {
      record("恢复测试起点模型", false, String(e));
    }
    pet.close();
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(`${OUT}/model_switch_verify.json`, JSON.stringify({ at: new Date().toISOString(), results, failed: failed.map((f) => f.name) }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("VERIFY ERROR:", e); process.exit(2); });
