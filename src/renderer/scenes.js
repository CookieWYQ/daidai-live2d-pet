// 动作与场景面板（task-13）：场景目录（一个模型 = 一个可切换场景，带描述/whenToUse）
// + 当前模型的动作/场景；辅助剖面模型与实验性半脱有明确标识与限制。
(function () {
  var api = window.daidaiPet;
  var root = document.getElementById("scenes-app");
  var appState = null;
  var lastSceneState = null;
  var statusText = "";
  var CATEGORY_EMOJI = { "换装": "👗", "亲密": "💗", "情绪": "😊", "日常": "🌤", "实验性": "🧪", "辅助": "🩻", "其他": "🎬" };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sceneConfig() {
    return (appState && appState.sceneConfig) || null;
  }

  function catalog() {
    return (appState && appState.sceneCatalog) || null;
  }

  function selectedModelId() {
    return (appState && appState.config && appState.config.selectedModelId) || "";
  }

  function selectedModel() {
    return (appState && appState.selectedModel) || null;
  }

  function modelEntry() {
    var cfg = sceneConfig();
    if (!cfg || !cfg.models) return null;
    return cfg.models[selectedModelId()] || cfg.models.__fallback__ || null;
  }

  function currentCatalogEntry() {
    var cat = catalog();
    var model = selectedModel();
    if (!cat || !cat.models || !model) return null;
    if (cat.models[model.id]) return cat.models[model.id];
    var dir = String(model.modelDirName || "").toLowerCase();
    var found = null;
    Object.keys(cat.models).some(function (id) {
      var entry = cat.models[id];
      if (String(entry.modelDirName || "").toLowerCase() === dir) { found = entry; return true; }
      return false;
    });
    return found;
  }

  function scenes() {
    var entry = modelEntry();
    return (entry && entry.scenes) || [];
  }

  function isSfwActive() {
    return Boolean(appState && appState.sfw && appState.sfw.sfw);
  }

  function categoryOrder() {
    var cfg = sceneConfig();
    var order = cfg && cfg.defaults && cfg.defaults.categoryOrder;
    var base = Array.isArray(order) && order.length ? order : ["换装", "亲密", "情绪", "日常", "实验性", "其他"];
    return base.indexOf("实验性") === -1 ? base.concat(["实验性"]) : base;
  }

  // 角色注册表：优先用 characters.json 里的角色名（比 scene-catalog 的 game 名更准确）
  function characterForEntry(entry) {
    var chars = appState && appState.characters;
    if (!chars || !chars.characters || !entry || !entry.modelId) return null;
    var id = chars.byModel ? chars.byModel[entry.modelId] : "";
    if (!id) {
      for (var i = 0; i < chars.characters.length; i++) {
        var item = chars.characters[i];
        if ((item.modelIds || []).indexOf(entry.modelId) !== -1) { id = item.id; break; }
      }
    }
    if (!id) return null;
    for (var j = 0; j < chars.characters.length; j++) {
      if (chars.characters[j].id === id) return chars.characters[j];
    }
    return null;
  }

  function catalogGames() {
    var cat = catalog();
    if (!cat || !cat.models) return [];
    var games = new Map();
    Object.keys(cat.models).forEach(function (id) {
      var entry = cat.models[id];
      var gameKey = (entry.bundle || "") + "|" + (entry.game || "");
      if (!games.has(gameKey)) {
        games.set(gameKey, { key: gameKey, bundleLabel: entry.bundleLabel || "", game: entry.game || "", characters: new Map() });
      }
      var game = games.get(gameKey);
      var character = characterForEntry(entry);
      var charKey = character ? character.name : (entry.character || entry.game || "");
      if (!game.characters.has(charKey)) game.characters.set(charKey, { label: charKey, character: character, entries: [] });
      game.characters.get(charKey).entries.push(entry);
    });
    return [...games.values()];
  }

  function badge(entry) {
    var out = [];
    if (entry.kind === "auxiliary") out.push('<span class="scenes-badge no">🩻 辅助·剖面（非人物）</span>');
    if (entry.nsfwOnly) out.push('<span class="scenes-badge no">🔞 NSFW 限定</span>');
    if (entry.opaqueFullFrame) out.push('<span class="scenes-badge">🖼 全屏CG场景</span>');
    if (entry.confidence === "medium") out.push('<span class="scenes-badge">证据：模型名（medium）</span>');
    if (entry.confidence === "unknown") out.push('<span class="scenes-badge no">语义未取证</span>');
    return out.join("");
  }

  function renderCatalogSection() {
    var cat = catalog();
    if (!cat || !cat.models) return "";
    var sfw = isSfwActive();
    var currentId = selectedModelId();
    var currentEntry = currentCatalogEntry();
    var games = catalogGames();
    var html = [
      '<section class="scene-catalog">',
      '  <div class="scene-catalog-head">',
      "    <h2>📖 场景目录（一个模型 = 一个可切换场景）</h2>",
      '    <span class="muted">点击卡片 = 切换模型 + 播放该场景代表动作；描述与「何时用」同时提供给 AI 作为选择依据。</span>',
      "  </div>"
    ];
    if (currentEntry) {
      html.push('<div class="scene-current-desc"><strong>当前场景：' + escapeHtml(currentEntry.sceneLabel) + "</strong>" +
        "（" + escapeHtml(currentEntry.category) + "）<br>" + escapeHtml(currentEntry.description) +
        "<br><span class=\"muted\">何时用：" + escapeHtml(currentEntry.whenToUse) + "</span></div>");
    }
    if (sfw) {
      html.push('<div class="scene-sfw-hint">🔒 当前 SFW 开启：NSFW 限定场景 / 辅助剖面模型暂不可用；需要时先在托盘菜单开启 NSFW。</div>');
    }
    games.forEach(function (game) {
      var gameModelCount = 0;
      game.characters.forEach(function (group) { gameModelCount += group.entries.length; });
      html.push('<div class="scene-game"><h3>' + escapeHtml(game.bundleLabel) + " · " + escapeHtml(game.game) + " <span class=\"muted\">" + gameModelCount + " 个场景</span></h3>");
      game.characters.forEach(function (group) {
        var characterInfo = group.character;
        var charBadge = characterInfo
          ? ' <span class="muted">· 角色卡：' + (characterInfo.overridden ? "已自定义" : "内置") + " · " + (characterInfo.modelIds || []).length + " 个模型</span>"
          : "";
        html.push('<div class="scene-character"><h4>' + escapeHtml(group.label) + charBadge + "</h4><div class=\"scene-catalog-grid\">");
        group.entries.forEach(function (entry) {
          var blocked = sfw && (entry.nsfwOnly || entry.kind === "auxiliary");
          var isCurrent = entry.modelId === currentId;
          html.push([
            '<button class="catalog-card' + (isCurrent ? " current" : "") + (blocked ? " blocked" : "") + '"',
            ' data-catalog-model="' + escapeHtml(entry.modelId) + '"',
            ' title="' + escapeHtml((entry.description || "") + "\n\n何时用：" + (entry.whenToUse || "")) + '">',
            '  <span class="catalog-label">' + (isCurrent ? "▶ " : "") + escapeHtml(entry.sceneLabel) + "</span>",
            '  <span class="catalog-badges">' + badge(entry) + (isCurrent ? '<span class="scenes-badge ok">当前</span>' : "") + "</span>",
            '  <span class="catalog-desc">' + escapeHtml(String(entry.description || "").slice(0, 120)) + "</span>",
            '  <span class="catalog-when">何时用：' + escapeHtml(String(entry.whenToUse || "").slice(0, 90)) + "</span>",
            "</button>"
          ].join(""));
        });
        html.push("</div></div>");
      });
      html.push("</div>");
    });
    html.push("</section>");
    return html.join("");
  }

  function renderCurrentScenes() {
    var model = selectedModel();
    var entry = modelEntry();
    var sceneList = scenes();
    var runningId = lastSceneState && lastSceneState.current && lastSceneState.current.running ? lastSceneState.current.id : "";
    var finishedId = lastSceneState && lastSceneState.lastFinished ? lastSceneState.lastFinished.id : "";
    var groups = {};
    for (var i = 0; i < sceneList.length; i += 1) {
      var scene = sceneList[i];
      var cat = scene.category || "其他";
      (groups[cat] = groups[cat] || []).push(scene);
    }
    var order = categoryOrder().filter(function (cat) { return groups[cat] && groups[cat].length; });
    Object.keys(groups).forEach(function (cat) { if (order.indexOf(cat) === -1) order.push(cat); });

    var body = order.map(function (cat) {
      var cards = groups[cat].map(function (scene) {
        var running = runningId === scene.id;
        var done = !running && finishedId === scene.id;
        var params = scene.params && Object.keys(scene.params).length
          ? Object.keys(scene.params).map(function (key) { return key + "=" + scene.params[key]; }).join(", ")
          : "";
        var meta = [];
        if (scene.motions && scene.motions.length) meta.push("🎞 " + scene.motions.map(function (m) { return m.name; }).join(" / "));
        if (params) meta.push("🎛 " + params);
        if (scene.experimental) meta.push("🧪 启发式·非官方素材（参数中间值插值）");
        if (scene.hint) meta.push(scene.hint);
        if (!meta.length) meta.push("纯动作场景");
        var title = scene.experimental ? (scene.heuristicNote || "启发式半脱：不是原模型素材，默认不自动触发") : (params || scene.hint || scene.label);
        return [
          '<button class="scene-btn category-' + escapeHtml(cat) + (running ? " running" : "") + (done ? " done" : "") + (scene.experimental ? " experimental" : "") + '"',
          ' data-scene-id="' + escapeHtml(scene.id) + '" title="' + escapeHtml(title) + '">',
          '  <span class="scene-tag">' + escapeHtml(cat) + "</span>",
          '  <span class="scene-label">' + (running ? "▶ " : "") + escapeHtml(scene.label) + (scene.experimental ? ' <span class="exp-badge">🧪 启发式·非官方素材</span>' : "") + "</span>",
          '  <span class="scene-meta">' + escapeHtml(meta.join(" · ")) + "</span>",
          "</button>"
        ].join("");
      }).join("");
      return [
        '<section class="scene-group">',
        "  <h2>" + (CATEGORY_EMOJI[cat] || "") + " " + escapeHtml(cat) + (cat === "实验性" ? ' <span class="muted">（默认不自动触发，仅手动）</span>' : "") + "</h2>",
        '  <div class="scene-grid">' + cards + "</div>",
        "</section>"
      ].join("");
    }).join("");

    if (!body) {
      body = '<div class="scenes-empty">当前模型还没有场景配置。<br>打开 <code>app/config/scenes.json</code> 为模型添加场景后点击「刷新」。</div>';
    }
    return [
      '<section class="current-model-scenes">',
      '  <h2>🎬 当前模型动作/场景</h2>',
      '  <div class="scenes-strip"><strong>' + escapeHtml((model && model.name) || selectedModelId() || "未选择模型") + "</strong>" +
        '<span class="muted">场景 ' + sceneList.length + " 个</span></div>",
      body,
      "</section>"
    ].join("");
  }

  function render() {
    if (!appState) return;
    var model = selectedModel();
    var catEntry = currentCatalogEntry();
    var aiEnabled = appState.sceneAutoEnabled !== false && !(sceneConfig() && sceneConfig().ai && sceneConfig().ai.enabled === false);
    var stateLine = "";
    if (lastSceneState && lastSceneState.current) {
      var cur = lastSceneState.current;
      stateLine = "最近场景：" + (CATEGORY_EMOJI[cur.category] || "") + " " + cur.label + " · 来源 " + (cur.source || "-") + (cur.running ? " · 执行中" : " · 已完成");
    } else if (statusText) {
      stateLine = statusText;
    }
    root.innerHTML = [
      '<div class="scenes-header">',
      "  <h1>🎬 场景与动作</h1>",
      '  <span class="scenes-model">' + escapeHtml((model && model.name) || selectedModelId() || "未选择模型") + "</span>",
      "</div>",
      '<div class="scenes-sub">场景 = 模型（同一角色的立绘/不同体位/辅助剖面等）。每个场景都有给 AI 看的描述与「何时用」，AI 只会在用户语义明确要求时切换；辅助剖面模型与 NSFW 限定场景在 SFW 下不可用。</div>',
      '<div class="scenes-badges">' +
        (catEntry ? '<span class="scenes-badge">' + escapeHtml(catEntry.sceneLabel) + "（" + escapeHtml(catEntry.category) + "）</span>" : "") +
        '<span class="scenes-badge">场景目录 ' + (catalog() && catalog().models ? Object.keys(catalog().models).length : 0) + " 个</span>" +
        '<span class="scenes-badge ' + (isSfwActive() ? "ok" : "no") + '">' + (isSfwActive() ? "🔒 SFW 开启" : "🔓 NSFW 清晰") + "</span>" +
        '<span class="scenes-badge ' + (aiEnabled ? "ok" : "no") + '">' + (aiEnabled ? "🤖 AI 自动切换：开" : "🤖 AI 自动切换：关") + "</span>" +
        "</div>",
      '<div class="scenes-toolbar">',
      '  <button id="scene-random">🎲 随机场景（不含实验性）</button>',
      '  <button id="scene-reset" class="ghost">↺ 重置场景状态</button>',
      '  <button id="scene-refresh" class="ghost">⟳ 刷新</button>',
      '  <button id="scene-open-config" class="ghost">⚙ 打开 scenes.json</button>',
      '  <button id="scene-close" class="ghost">✕ 关闭面板</button>',
      "</div>",
      '<div class="scenes-status">' + escapeHtml(stateLine) + "</div>",
      renderCatalogSection(),
      renderCurrentScenes(),
      '<div class="scenes-footer">',
      "场景目录文件：<code>app/config/scene-catalog.json</code>（63 个模型逐一取证；folder1 统一角色立绘，folder2 依据 model_info/links/游戏 scenario 脚本标注）。<br>",
      "实验性半脱：<code>tachie_ani</code> 的「半脱（实验性）」是通过参数中间值插值得到的启发式效果，<b>不是原模型素材</b>，默认不自动触发，只在「实验性」分类手动点击。<br>",
      "AI 标签协议：回复末尾输出 <code>[scene:场景id]</code>（也可用场景目录 model_id）触发；NSFW 关闭时 NSFW 限定场景会被拒绝并回退普通场景。",
      "</div>"
    ].join("");
    bindButtons();
  }

  function bindButtons() {
    var cards = root.querySelectorAll("[data-catalog-model]");
    for (var i = 0; i < cards.length; i += 1) {
      cards[i].addEventListener("click", async function () {
        var modelId = this.getAttribute("data-catalog-model");
        if (this.classList.contains("blocked")) {
          statusText = "该场景为 NSFW 限定/辅助剖面模型：请先在托盘菜单开启 NSFW";
          render();
          return;
        }
        statusText = "正在切换场景…";
        try {
          var result = await api.playCatalogScene(modelId, "");
          if (result && result.ok === false) statusText = "切换失败：" + (result.message || result.reason || "unknown");
          else statusText = "已切换场景：" + ((result && result.sceneLabel) || modelId);
        } catch (error) {
          statusText = "切换失败：" + (error && error.message ? error.message : error);
        }
        render();
      });
    }
    var nodes = root.querySelectorAll("[data-scene-id]");
    for (var k = 0; k < nodes.length; k += 1) {
      nodes[k].addEventListener("click", async function () {
        var id = this.getAttribute("data-scene-id");
        statusText = "正在执行：" + id;
        try {
          var result = await api.playScene(id);
          if (result && result.ok === false) statusText = "执行失败：" + (result.reason || "unknown");
        } catch (error) {
          statusText = "执行失败：" + (error && error.message ? error.message : error);
        }
        render();
      });
    }
    function on(id, handler) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("click", handler);
    }
    on("scene-random", async function () {
      var pool = scenes().filter(function (scene) { return !scene.experimental; });
      if (!pool.length) return;
      var scene = pool[Math.floor(Math.random() * pool.length)];
      await api.playScene(scene.id);
      render();
    });
    on("scene-reset", async function () {
      await api.resetSceneState();
      statusText = "场景状态已重置";
      render();
    });
    on("scene-refresh", async function () {
      appState = await api.getState();
      render();
    });
    on("scene-open-config", function () { api.openScenesConfig(); });
    on("scene-close", function () { api.closeScenesPanel(); });
  }

  async function boot() {
    appState = await api.getState();
    render();
    api.onUpdate(function (next) {
      appState = next;
      render();
    });
    if (api.onSceneState) {
      api.onSceneState(function (state) {
        lastSceneState = state;
        render();
      });
    }
  }

  boot().catch(function (error) {
    root.innerHTML = '<div class="scenes-empty">场景面板启动失败：' + escapeHtml(error && error.message ? error.message : error) + "</div>";
  });
})();
