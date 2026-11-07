// 端到端验证：聊天悬浮层（follow 头顶锚点 / 拖动保存 / 不带动宠物窗）
// + AI 控制缩放（工具 schema / 执行器开关 / mock LLM function calling 全链路）
// 依赖：Electron 以 --remote-debugging-port=9333 + DAIDAI_DEBUG_HOOKS=1 启动
// 用法：node scripts/verify-overlay-ai.mjs --port=9333 --out=../screenshots/overlay
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(argOf("port", 9333));
const OUT = path.resolve(argOf("out", path.join(process.cwd(), "..", "screenshots", "overlay")));
const MOCK_PORT = Number(argOf("mock-port", 18907));
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
  const mouse = async (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
  async function drag(from, to, steps = 6) {
    await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await mouse("mouseMoved", x, y, { buttons: 1 });
      await sleep(30);
    }
    await mouse("mouseReleased", to.x, to.y, { clickCount: 1, buttons: 0 });
    await sleep(400);
  }
  return { send, evaluate, screenshot, mouse, drag, close: () => ws.close() };
}

function startMockLlm(mode = "tool") {
  let turn = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const hasToolResult = Array.isArray(payload.messages) && payload.messages.some((m) => m.role === "tool");
      turn += 1;
      let message;
      if (mode === "tool" && !hasToolResult && turn === 1) {
        message = {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_scale_1", type: "function", function: { name: "set_scale", arguments: JSON.stringify({ percent: 40 }) } }]
        };
      } else {
        message = { role: "assistant", content: "好的，已经帮你调整好啦～" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "mock", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const targets = await listTargets();
  const petT = targets.find((t) => t.type === "page" && t.url.includes("view=pet"));
  const mgrT = targets.find((t) => t.type === "page" && t.url.includes("view=manager"));
  if (!petT) throw new Error("找不到宠物窗 target（调试端口是否开着？）");
  const pet = await connect(petT.webSocketDebuggerUrl);
  const mgr = mgrT ? await connect(mgrT.webSocketDebuggerUrl) : null;

  const original = await pet.evaluate(`(async () => {
    const st = await window.daidaiPet.getState();
    return { overlay: st.config.overlay, aiControl: st.config.aiControl, tavern: { textBaseUrl: st.config.tavern.textBaseUrl, textApiKey: st.config.tavern.textApiKey, textModel: st.config.tavern.textModel }, petScale: st.config.petScale };
  })()`);

  try {
    // 起始清理：关聊天面板、清空气泡，保证拖动命中率
    await pet.evaluate(`(() => {
      const p = document.getElementById('chat-panel');
      if (p && p.classList.contains('open')) { const b = document.getElementById('chat-panel-close'); if (b) b.click(); }
      const stack = document.getElementById('chat-bubble-stack'); if (stack) stack.innerHTML = '';
      return true;
    })()`);
    await sleep(400);
    // 制造一条气泡，便于检查 follow 锚点与拖动
    await pet.evaluate(`(async () => { try { if (window.__petDebug && window.__petDebug.simulateChatBubble) return window.__petDebug.simulateChatBubble('测试气泡：文字应该贴在模型头顶'); } catch (e) {} return false; })()`);
    await sleep(500);
    // ============ 1. 悬浮层默认布局（follow 头顶） ============
    const layout = await pet.evaluate(`(() => {
      const stage = document.getElementById('pet-stage');
      const stack = document.getElementById('chat-bubble-stack');
      const bar = document.getElementById('tavern-bar');
      const panel = document.getElementById('chat-panel');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      return { stage: r(stage), stack: r(stack), bar: r(bar), panel: r(panel), stackCS: stack ? getComputedStyle(stack).top + '/' + getComputedStyle(stack).left + ' transform=' + getComputedStyle(stack).transform : null };
    })()`);
    record("悬浮层元素存在", Boolean(layout.stack && layout.bar && layout.panel), layout);
    const overlayState = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay)()`);
    record("config.overlay 已写入", Boolean(overlayState && overlayState.bubble && overlayState.input && overlayState.panel), overlayState);
    const followOk = overlayState && overlayState.bubble && overlayState.bubble.mode === "follow" && layout.stack && layout.stack.y >= 0 && layout.stack.y + layout.stack.h < (layout.stage ? layout.stage.h * 0.55 : 999);
    record("气泡跟随头顶（不是底部 58px 固定位）", Boolean(followOk), { stack: layout.stack, stage: layout.stage });

    // 输入条在底部但位置由百分比控制
    const barOk = layout.bar && layout.stage && layout.bar.y > layout.stage.h * 0.7;
    record("输入条默认在底部区域", Boolean(barOk), layout.bar);

    // ============ 2. 拖动保存（输入条 / 面板 / 气泡）+ 窗口不移动 ============
    // 2a. 输入条拖动：只认 ⠿ 把手
    const grip = await pet.evaluate(`(() => {
      const bar = document.getElementById('tavern-bar');
      if (!bar) return null;
      const g = bar.querySelector('.overlay-grip, #tavern-drag-handle, [data-drag-handle]');
      const el = g || bar;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), isGrip: Boolean(g) };
    })()`);
    const inputBefore = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay.input)()`);
    const boundsBeforeInput = await pet.evaluate(`window.daidaiDebug.petBounds()`);
    if (grip) {
      await pet.drag(grip, { x: grip.x + 36, y: grip.y - 40 });
      await sleep(500);
      const inputAfter = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay.input)()`);
      const changed = inputBefore && inputAfter && (Math.abs(inputAfter.x - inputBefore.x) > 0.5 || Math.abs(inputAfter.y - inputBefore.y) > 0.5);
      record("拖动输入条后 overlay.input 百分比已保存", Boolean(changed), { before: inputBefore, after: inputAfter, grip });
    } else {
      record("拖动输入条后 overlay.input 百分比已保存", false, "找不到拖动把手");
    }
    const boundsAfterInput = await pet.evaluate(`window.daidaiDebug.petBounds()`);
    const inputNoMove = boundsBeforeInput && boundsAfterInput &&
      Math.abs(boundsBeforeInput.bounds.x - boundsAfterInput.bounds.x) <= 1 &&
      Math.abs(boundsBeforeInput.bounds.y - boundsAfterInput.bounds.y) <= 1;
    record("拖动输入条不会移动宠物窗口", Boolean(inputNoMove), { before: boundsBeforeInput.bounds, after: boundsAfterInput.bounds });

    // 2b. 聊天记录面板拖动：热键打开 → 拖标题栏 → 关闭
    await pet.evaluate(`(async () => { try { await window.daidaiDebug.triggerHotkey('toggleChat'); } catch (e) {} return true; })()`);
    await sleep(700);
    const panelOpen = await pet.evaluate(`(() => { const p = document.getElementById('chat-panel'); return p ? p.classList.contains('open') : false; })()`);
    if (panelOpen) {
      const headPos = await pet.evaluate(`(() => {
        const p = document.getElementById('chat-panel');
        const h = p.querySelector('.chat-panel-head');
        const r = h.getBoundingClientRect();
        return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) };
      })()`);
      const panelBefore = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay.panel)()`);
      await pet.drag(headPos, { x: headPos.x - 40, y: headPos.y + 30 });
      await sleep(500);
      const panelAfter = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay.panel)()`);
      const panelChanged = panelBefore && panelAfter && (Math.abs(panelAfter.x - panelBefore.x) > 0.5 || Math.abs(panelAfter.y - panelBefore.y) > 0.5);
      record("拖动聊天记录面板后 overlay.panel 已保存", Boolean(panelChanged), { before: panelBefore, after: panelAfter });
    } else {
      record("拖动聊天记录面板后 overlay.panel 已保存", false, "面板没有打开");
    }
    // 关闭面板，避免遮住气泡影响拖动命中
    await pet.evaluate(`(() => { const b = document.getElementById('chat-panel-close'); if (b) b.click(); return true; })()`);
    await sleep(500);

    // 2c. 用 mock LLM 聊一句，气泡出现后拖动气泡（面板已关闭）
    await pet.evaluate(`(() => { const stack = document.getElementById('chat-bubble-stack'); if (stack) stack.innerHTML = ''; return true; })()`);
    const mock = await startMockLlm("text");
    try {
      await pet.evaluate(`(async () => {
        await window.daidaiPet.setConfig({ tavern: Object.assign({}, (await window.daidaiPet.getState()).config.tavern, { textBaseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1', textApiKey: 'mock-key', textModel: 'mock', ttsToken: '' }) });
        return true;
      })()`);
      await sleep(500);
      await pet.evaluate(`window.__sendTavernMessage ? window.__sendTavernMessage('测试悬浮气泡拖动') : false`);
      await sleep(2500);
      const bubbleInfo = await pet.evaluate(`(() => {
        const stack = document.getElementById('chat-bubble-stack');
        const b = stack ? stack.querySelector('.chat-bubble') : null;
        if (!b) return { count: 0 };
        const r = b.getBoundingClientRect();
        return { count: stack.querySelectorAll('.chat-bubble').length, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (b.querySelector('.chat-bubble-text') || {}).textContent };
      })()`);
      const bubbleBefore = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay.bubble)()`);
      const boundsBeforeBubble = await pet.evaluate(`window.daidaiDebug.petBounds()`);
      if (bubbleInfo.count > 0) {
        await pet.drag({ x: bubbleInfo.x, y: bubbleInfo.y }, { x: bubbleInfo.x + 20, y: bubbleInfo.y + 45 });
        await sleep(600);
        const bubbleAfter = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.overlay.bubble)()`);
        const bubbleChanged = bubbleBefore && bubbleAfter && bubbleAfter.mode === "manual" && (Math.abs(bubbleAfter.x - bubbleBefore.x) > 0.5 || Math.abs(bubbleAfter.y - bubbleBefore.y) > 0.5);
        record("拖动气泡后切 manual 且位置已保存", Boolean(bubbleChanged), { before: bubbleBefore, after: bubbleAfter, text: String(bubbleInfo.text || "").slice(0, 30) });
      } else {
        record("拖动气泡后切 manual 且位置已保存", false, bubbleInfo);
      }
      const boundsAfterBubble = await pet.evaluate(`window.daidaiDebug.petBounds()`);
      const bubbleNoMove = boundsBeforeBubble && boundsAfterBubble &&
        Math.abs(boundsBeforeBubble.bounds.x - boundsAfterBubble.bounds.x) <= 1 &&
        Math.abs(boundsBeforeBubble.bounds.y - boundsAfterBubble.bounds.y) <= 1;
      record("拖动气泡不会移动宠物窗口", Boolean(bubbleNoMove), { before: boundsBeforeBubble.bounds, after: boundsAfterBubble.bounds });
      await pet.screenshot(`${OUT}/pet_overlay_after.png`);
    } finally {
      mock.close();
    }

    // ============ 3. AI 控制缩放 ============
    const scaleBefore = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.petScale)()`);
    await pet.evaluate(`(async () => { await window.daidaiPet.setConfig({ aiControl: { scaleEnabled: true } }); return true; })()`);
    await sleep(1500);
    const capsOn = await pet.evaluate(`(async () => { const c = window.__petDebug.getCapabilities(); return { tools: (c.tools || []).map(t => t.function && t.function.name), scale: c.scale, sceneAi: c.scene_ai_enabled }; })()`);
    record("开启后能力清单含 set_scale", Boolean(capsOn.tools && capsOn.tools.includes("set_scale")), capsOn.tools);
    record("capabilities.scale.controllable=true", Boolean(capsOn.scale && capsOn.scale.controllable), capsOn.scale);

    const toolRes = await pet.evaluate(`window.__petDebug.simulateToolCall('set_scale', { percent: 40 })`);
    await sleep(1200);
    const scaleAfter = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.petScale)()`);
    record("执行 set_scale(40) 后 petScale≈0.4", Boolean(toolRes && toolRes.ok && Math.abs(Number(scaleAfter) - 0.4) < 0.03), { toolRes, scaleBefore, scaleAfter });

    // mock LLM 全链路：先把缩放重置回原值，模型返回 tool_calls set_scale，主进程转发执行
    await pet.evaluate(`window.daidaiPet.setPetScale(${Number(original.petScale) || 0.25})`);
    await sleep(1200);
    const mock2 = await startMockLlm("tool");
    try {
      await pet.evaluate(`(async () => {
        const st = await window.daidaiPet.getState();
        await window.daidaiPet.setConfig({ tavern: Object.assign({}, st.config.tavern, { textBaseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1', textApiKey: 'mock-key', textModel: 'mock', ttsToken: '' }) });
        return true;
      })()`);
      await sleep(400);
      const s0 = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.petScale)()`);
      await pet.evaluate(`window.__sendTavernMessage ? window.__sendTavernMessage('把我变小一点') : false`);
      await sleep(3500);
      const s1 = await pet.evaluate(`(async () => (await window.daidaiPet.getState()).config.petScale)()`);
      const log = await pet.evaluate(`window.__petDebug.toolLog()`);
      const toolUsed = Array.isArray(log) && log.some((item) => item && item.name === "set_scale");
      record("mock LLM tool_calls 全链路触发 set_scale 生效", Boolean(toolUsed && Math.abs(Number(s1) - 0.4) < 0.03), { s0, s1, log: (log || []).slice(-3) });
      await pet.screenshot(`${OUT}/pet_ai_scale_40.png`);
    } finally {
      mock2.close();
    }

    // 关闭后工具消失、执行器拒绝
    await pet.evaluate(`(async () => { await window.daidaiPet.setConfig({ aiControl: { scaleEnabled: false } }); return true; })()`);
    await sleep(1500);
    const capsOff = await pet.evaluate(`(async () => { const c = window.__petDebug.getCapabilities(); return { tools: (c.tools || []).map(t => t.function && t.function.name), scale: c.scale }; })()`);
    const toolOff = await pet.evaluate(`window.__petDebug.simulateToolCall('set_scale', { percent: 180 })`);
    record("关闭后无 set_scale 工具且执行器拒绝", Boolean(capsOff.tools && !capsOff.tools.includes("set_scale") && toolOff && toolOff.ok === false), { tools: capsOff.tools, toolOff });

    // 恢复原配置（含缩放/窗口尺寸）
    await pet.evaluate(`(async () => {
      await window.daidaiPet.setConfig({ overlay: ${JSON.stringify(original.overlay)}, aiControl: ${JSON.stringify(original.aiControl)}, tavern: ${JSON.stringify(original.tavern)} });
      if (window.daidaiPet.setPetScale) { try { await window.daidaiPet.setPetScale(${Number(original.petScale) || 0.25}); } catch (e) {} }
      return true;
    })()`);
    await sleep(1200);
    record("还原用户配置", true, { overlay: original.overlay && true, aiControl: original.aiControl });
  } finally {
    if (mgr) mgr.close();
    pet.close();
  }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(`${OUT}/overlay_ai_verify.json`, JSON.stringify({ at: new Date().toISOString(), results, failed: failed.map((f) => f.name) }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("VERIFY ERROR:", e); process.exit(2); });
