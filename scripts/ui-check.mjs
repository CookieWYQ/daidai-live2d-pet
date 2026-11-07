#!/usr/bin/env node
// UI 自检：用 CDP 驱动正在运行的桌宠（需 --remote-debugging-port 与 DAIDAI_DEBUG_HOOKS=1）。
// 覆盖：快捷键注册状态 / 快捷键动作 / 精细缩放 / 聊天文字气泡（TTS 未配置）/ 聊天记录面板 / 截图。
// 用法：node scripts/ui-check.mjs --port=9333 --out=../screenshots
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(argOf("port", 9333));
const OUT_DIR = path.resolve(argOf("out", path.join(process.cwd(), "..", "screenshots")));
const MOCK_PORT = Number(argOf("mock-port", 18901));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true
    });
    if (out.exceptionDetails) {
      const desc = out.exceptionDetails.exception && out.exceptionDetails.exception.description;
      throw new Error(`evaluate failed: ${out.exceptionDetails.text} ${desc || ""}`);
    }
    return out.result.value;
  };
  const screenshot = async (filePath) => {
    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(shot.data, "base64"));
    return filePath;
  };
  return { send, evaluate, screenshot, close: () => ws.close() };
}

function startMockLlm() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404).end("not found");
        return;
      }
      let reply = "收到啦～这是一条没有 TTS 也能看到的文字回复。";
      try {
        const payload = JSON.parse(body);
        const last = Array.isArray(payload.messages) ? payload.messages[payload.messages.length - 1] : null;
        if (last && String(last.content || "").includes("历史")) reply = "历史记录测试回复：第二条消息。";
      } catch {}
      const json = {
        id: "mock-1",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const targets = await listTargets();
  const petTarget = targets.find((t) => t.type === "page" && t.url.includes("view=pet"));
  const managerTarget = targets.find((t) => t.type === "page" && t.url.includes("view=manager"));
  if (!petTarget) throw new Error("找不到桌宠渲染进程目标（--remote-debugging-port 是否开着？）");
  const pet = await connect(petTarget.webSocketDebuggerUrl);
  const manager = managerTarget ? await connect(managerTarget.webSocketDebuggerUrl) : null;

  // 1. 快捷键注册状态
  const hotkeys = await pet.evaluate("window.daidaiDebug.hotkeys()");
  const status = (hotkeys && hotkeys.status) || [];
  record("快捷键状态可查询", Array.isArray(status) && status.length > 0, `共 ${status.length} 项，已注册 ${status.filter((s) => s.registered).length} 项`);
  const failed = status.filter((s) => s.accelerator && !s.registered);
  record("快捷键全部注册成功", failed.length === 0, failed.map((s) => `${s.name}:${s.error}`).join(" | ") || "无失败");

  // 2. 快捷键动作：先用 520×720 的干净基准隔离「屏幕尺寸限制」，否则真实 base 偏大时会按工作区回退
  const originalPetScale = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.petScale)");
  const boundsSnapshot = await pet.evaluate("window.daidaiDebug.petBounds()");
  const originalBase = (boundsSnapshot && boundsSnapshot.petScale && boundsSnapshot.petScale.base) || null;
  await pet.evaluate("window.daidaiDebug.setScaleBase({ width: 520, height: 720 })");
  await sleep(400);
  await pet.evaluate("window.daidaiDebug.applyScale(0.5)");
  await sleep(800);
  const before = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.petScale)");
  await pet.evaluate("window.daidaiDebug.triggerHotkey('scaleUp')");
  await sleep(600);
  const after = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.petScale)");
  record("快捷键放大桌宠", Math.abs(after - before - 0.05) < 1e-6, `${before} -> ${after}`);

  await pet.evaluate("window.daidaiDebug.triggerHotkey('scaleDown')");
  await sleep(600);
  const back = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.petScale)");
  record("快捷键缩小桌宠", Math.abs(back - before) < 1e-6, `${after} -> ${back}`);

  await pet.evaluate("window.daidaiDebug.triggerHotkey('scaleUpFine')");
  await sleep(500);
  const fine = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.petScale)");
  record("快捷键精细放大 +1%", Math.abs(fine - back - 0.01) < 1e-6, `${back} -> ${fine}`);
  await pet.evaluate("window.daidaiDebug.triggerHotkey('scaleDownFine')");
  await sleep(400);

  const sfwBefore = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.nsfwMode)");
  await pet.evaluate("window.daidaiDebug.triggerHotkey('toggleSfw')");
  await sleep(500);
  const sfwAfter = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.nsfwMode)");
  record("快捷键切换 SFW/NSFW", sfwBefore !== sfwAfter || (await pet.evaluate("window.daidaiPet.getState().then(s => s.sfw && s.sfw.forced)")), `${sfwBefore} -> ${sfwAfter}`);
  if (sfwBefore !== sfwAfter) {
    await pet.evaluate("window.daidaiDebug.triggerHotkey('toggleSfw')");
    await sleep(400);
  }

  const topBefore = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.alwaysOnTop)");
  await pet.evaluate("window.daidaiDebug.triggerHotkey('toggleAlwaysOnTop')");
  await sleep(500);
  const topAfter = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.alwaysOnTop)");
  record("快捷键切换总在最前", topBefore !== topAfter, `${topBefore} -> ${topAfter}`);
  await pet.evaluate("window.daidaiDebug.triggerHotkey('toggleAlwaysOnTop')");
  await sleep(400);

  // 3. 精细缩放：25% 下限 / 100% 重置 / 数字框
  const boundsBefore = await pet.evaluate("window.daidaiDebug.petBounds()");
  await pet.evaluate("window.daidaiDebug.applyScale(0.25)");
  await sleep(700);
  const bounds25 = await pet.evaluate("window.daidaiDebug.petBounds()");
  record("25% 档位可生效", bounds25 && bounds25.petScale && Math.abs(bounds25.petScale.scale - 0.25) < 1e-6, `scale=${bounds25 && bounds25.petScale && bounds25.petScale.scale}`);
  record("25% 宽度小于 100%", bounds25 && boundsBefore && bounds25.bounds.width < boundsBefore.bounds.width, `${bounds25.bounds.width} < ${boundsBefore.bounds.width}`);
  await pet.evaluate("window.daidaiDebug.applyScale(0.5)");
  await sleep(700);

  // 4. 聊天：TTS 未配置 + 本地 mock LLM → 必须出现文字气泡与历史
  const original = await pet.evaluate("window.daidaiPet.getState().then(s => s.config.tavern)");
  await pet.evaluate(`window.daidaiPet.setConfig({ tavern: { textBaseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1', textApiKey: 'ui-check-key', textModel: 'mock-model' } })`);
  await sleep(600);
  const ttsConfigured = await pet.evaluate("window.daidaiPet.getState().then(s => s.ttsConfigured)");
  record("TTS 未配置可识别", ttsConfigured === false, `ttsConfigured=${ttsConfigured}`);

  await pet.evaluate("window.daidaiDebug.triggerHotkey('toggleChat')");
  await sleep(600);
  const panelOpen = await pet.evaluate("(() => { const p = document.getElementById('chat-panel'); return !!p && p.classList.contains('open'); })()");
  record("快捷键打开聊天记录面板", panelOpen, `open=${panelOpen}`);

  await pet.evaluate("window.__sendTavernMessage('你好，测试没有 TTS 时的文字输出')");
  await sleep(3200);
  const bubbleText = await pet.evaluate("(() => Array.from(document.querySelectorAll('#chat-bubble-stack .chat-bubble-text')).map(el => el.textContent).join('|'))()");
  record("无 TTS 时显示文字气泡", String(bubbleText || "").includes("收到啦"), bubbleText || "(空)");
  const panelText = await pet.evaluate("(() => (document.getElementById('chat-panel-list') || {}).textContent || '')()");
  record("聊天记录面板显示消息", String(panelText).includes("测试没有 TTS"), String(panelText).slice(0, 120));

  await pet.screenshot(path.join(OUT_DIR, "v2_pet_chat_bubble.png"));
  await pet.screenshot(path.join(OUT_DIR, "v2_pet_chat_panel.png"));
  record("桌宠截图已保存", true, path.join(OUT_DIR, "v2_pet_chat_bubble.png"));

  // 5. 历史持久化文件
  const history = await pet.evaluate("window.daidaiDebug.chatHistory()");
  const historyCount = history && history.stats ? history.stats.messages : 0;
  record("聊天记录已落盘", historyCount > 0, `messages=${historyCount} file=${history && history.file}`);

  f5: {
    // 6. 管理页截图（缩放区 / 快捷键区 / 聊天区）
    if (!manager) break f5;
    await pet.evaluate("window.daidaiDebug.showManager()");
    await sleep(2500);
    await manager.screenshot(path.join(OUT_DIR, "v2_manager_settings_full.png"));
    const managerDom = await manager.evaluate("(() => ({ scale: !!document.getElementById('pet-scale'), hotkeyRows: document.querySelectorAll('.hotkey-row').length, chatMode: !!document.getElementById('chat-text-mode') }))()");
    record("管理页含快捷键/聊天/精细缩放控件", Boolean(managerDom.manage) || (managerDom.scale && managerDom.hotkeyRows >= 10 && managerDom.chatMode), JSON.stringify(managerDom));
    // 滚动到快捷键区再截一张
    await manager.evaluate("(() => { const el = document.querySelector('.hotkey-section'); if (el) el.scrollIntoView({block:'start'}); return true; })()");
    await sleep(800);
    await manager.screenshot(path.join(OUT_DIR, "v2_manager_hotkeys.png"));
    await manager.evaluate("(() => { const el = document.querySelector('.chat-settings'); if (el) el.scrollIntoView({block:'start'}); return true; })()");
    await sleep(800);
    await manager.screenshot(path.join(OUT_DIR, "v2_manager_chat.png"));
  }

  // 7. 还原现场：mock 地址、基准尺寸、缩放、聊天记录
  await pet.evaluate(`window.daidaiPet.setConfig({ tavern: ${JSON.stringify({
    textBaseUrl: original.textBaseUrl,
    textApiKey: original.textApiKey,
    textModel: original.textModel
  })} })`);
  if (originalBase && originalBase.width && originalBase.height) {
    await pet.evaluate(`window.daidaiDebug.setScaleBase({ width: ${originalBase.width}, height: ${originalBase.height} })`);
    await sleep(300);
  }
  await pet.evaluate(`window.daidaiPet.setConfig({ petScale: ${originalPetScale} })`);
  await pet.evaluate("window.daidaiPet.clearChatHistory()");
  await pet.evaluate("window.daidaiDebug.triggerHotkey('toggleChat')");
  await sleep(500);

  pet.close();
  if (manager) manager.close();
  const failedCount = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failedCount}/${results.length} passed`);
  fs.writeFileSync(
    path.join(OUT_DIR, "v2_ui_check_summary.json"),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2)
  );
  process.exit(failedCount ? 1 : 0);
}

const server = await startMockLlm();
try {
  await main();
} finally {
  server.close();
}
