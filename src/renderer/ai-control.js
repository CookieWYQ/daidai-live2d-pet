// AI 控制能力层：把「当前模型」的动作/场景/换装能力 + 场景目录（63 模型场景语义）
// 整理成：(1) capability manifest (2) OpenAI 兼容 function calling 工具 schema (3) system prompt 能力简报
// 该文件只做纯数据构建，不依赖 Live2D 实例；执行器在 app.js 内。
(function () {
  "use strict";

  function sceneList(scenes) {
    return (scenes || []).map(function (scene) {
      return {
        id: scene.id,
        label: scene.label,
        category: scene.category,
        priority: scene.priority || 1,
        description: scene.description || "",
        when_to_use: scene.whenToUse || "",
        nsfw_only: Boolean(scene.nsfwOnly),
        experimental: Boolean(scene.experimental),
        heuristic: Boolean(scene.heuristic),
        hint: scene.hint || ""
      };
    });
  }

  function catalogSceneList(catalogScenes) {
    return (catalogScenes || []).map(function (entry) {
      return {
        scene_id: entry.modelId,
        model_id: entry.modelId,
        model_dir: entry.modelDirName || "",
        game: entry.game || "",
        character: entry.character || "",
        scene_label: entry.sceneLabel || "",
        category: entry.category || "",
        kind: entry.kind || "character",
        description: entry.description || "",
        when_to_use: entry.whenToUse || "",
        nsfw_only: Boolean(entry.nsfwOnly),
        current: Boolean(entry.current),
        opaque_full_frame: Boolean(entry.opaqueFullFrame)
      };
    });
  }

  function buildCapabilities(input) {
    var opts = input || {};
    var sceneCfg = opts.modelEntry || {};
    var aiControl = sceneCfg.aiControl || {};
    var scenes = sceneList(sceneCfg.scenes || []);
    var motionMap = opts.motionMap || {};
    var names = Object.keys(motionMap);
    var groups = {};
    names.forEach(function (name) {
      var group = String(motionMap[name].group || "");
      groups[group] = (groups[group] || 0) + 1;
    });
    var prefixes = Array.isArray(aiControl.motionPrefixes) && aiControl.motionPrefixes.length
      ? aiControl.motionPrefixes
      : [];
    var examples = names
      .filter(function (name) {
        if (!prefixes.length) return true;
        return prefixes.some(function (prefix) { return name.indexOf(prefix) === 0; });
      })
      .slice(0, 40);
    var catalogInfo = opts.catalog || {};
    var catalogScenes = catalogSceneList(catalogInfo.entries || []);
    // 缩放能力：percent=当前百分比，min/max=允许范围，controllable=管理页是否允许 AI 调整
    var scaleOpts = opts.scale || {};
    var scale = {
      percent: Number(scaleOpts.percent),
      min: Number(scaleOpts.min),
      max: Number(scaleOpts.max),
      controllable: Boolean(scaleOpts.controllable)
    };
    if (!isFinite(scale.percent)) scale.percent = 100;
    if (!isFinite(scale.min)) scale.min = 25;
    if (!isFinite(scale.max)) scale.max = 200;
    var currentEntry = catalogInfo.current ? {
      model_id: catalogInfo.current.modelId,
      game: catalogInfo.current.game,
      character: catalogInfo.current.character,
      scene_label: catalogInfo.current.sceneLabel,
      category: catalogInfo.current.category,
      kind: catalogInfo.current.kind,
      description: catalogInfo.current.description,
      when_to_use: catalogInfo.current.whenToUse,
      nsfw_only: Boolean(catalogInfo.current.nsfwOnly),
      opaque_full_frame: Boolean(catalogInfo.current.opaqueFullFrame)
    } : null;
    return {
      model_id: opts.modelId || "",
      model_name: opts.modelName || sceneCfg.displayName || opts.modelId || "",
      display_scale: sceneCfg.display ? sceneCfg.display.scale : null,
      sfw_active: Boolean(opts.sfwActive),
      // 「AI 自动切换场景/动作」总开关：关闭时下游不再生成场景类工具与说明（默认开启）
      scene_ai_enabled: opts.sceneAiEnabled !== false,
      // 缩放能力：controllable=false 时下游不生成 set_scale 工具
      scale: scale,
      scenes: scenes,
      catalog_scenes: catalogScenes,
      current_catalog_entry: currentEntry,
      catalog_path: catalogInfo.path || "",
      motions: {
        total: names.length,
        groups: Object.keys(groups).map(function (group) { return { group: group, count: groups[group] }; }),
        prefixes: prefixes,
        examples: examples,
        supports_play_by_name: true
      },
      clothing: aiControl.clothing || null,
      accessories: (aiControl.accessories || []).map(function (item) {
        return { id: item.id, label: item.label, has_motion: Boolean(item.onMotion || item.offMotion) };
      }),
      // 可切换模型目录：id 是机器 id，display_name/model_dir 是用户/管理器里看到的名字
      // （用户常说“换成 k04_kijoui_ani”这类名称，只给 id 模型无法映射）
      models: (opts.models || []).map(function (model) {
        return {
          id: model.id,
          name: model.name || model.displayName || model.id,
          display_name: model.displayName || model.name || model.id,
          dir: model.dir || model.modelDirName || "",
          game: model.game || "",
          kind: model.kind || "",
          nsfw_only: Boolean(model.nsfwOnly),
          scene_label: model.sceneLabel || "",
          category: model.category || "",
          description: model.description || "",
          when_to_use: model.whenToUse || "",
          keywords: Array.isArray(model.keywords) ? model.keywords : [],
          selected: model.id === opts.modelId
        };
      }),
      // 上一个模型：用于“换回去 / 切回刚才那个”
      previous_model: opts.previousModel ? {
        id: opts.previousModel.id,
        name: opts.previousModel.name || opts.previousModel.displayName || opts.previousModel.id,
        display_name: opts.previousModel.displayName || opts.previousModel.name || opts.previousModel.id
      } : null
    };
  }

  // ---- 模型名解析：用户/AI 说“k04_kijoui_ani”“骑乘位”“初冬暖阳R”都能对上模型 ----
  function normalizeModelQuery(value) {
    return String(value == null ? "" : value).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function modelAliases(model) {
    return [model.id, model.name, model.display_name, model.dir, model.scene_label]
      .concat(Array.isArray(model.keywords) ? model.keywords : [])
      .filter(Boolean).map(normalizeModelQuery);
  }

  function modelCandidate(model) {
    return { id: model.id, name: model.display_name || model.name || model.id, game: model.game || "" };
  }

  // 返回 {ok:true, model, matchedBy} 或 {ok:false, reason, message, candidates}
  // args 支持：model_id（精确 id）、model_name/query/name（名称/目录名/关键字模糊）、previous=true（上一个模型）
  function resolveModelTarget(models, args, previousModel) {
    var list = Array.isArray(models) ? models : [];
    var input = args || {};
    if (input.previous === true) {
      if (previousModel && previousModel.id) {
        var prevHit = list.filter(function (model) { return model.id === previousModel.id; })[0];
        return { ok: true, model: prevHit || previousModel, matchedBy: "previous" };
      }
      return { ok: false, reason: "no_previous", message: "没有上一个模型可切回（刚启动或没切换过）" };
    }
    var directId = normalizeModelQuery(input.model_id);
    if (directId) {
      var byId = list.filter(function (model) { return normalizeModelQuery(model.id) === directId; })[0];
      if (byId) return { ok: true, model: byId, matchedBy: "id" };
    }
    var query = normalizeModelQuery(
      input.model_name || input.query || input.name || input.model_id || input.target || ""
    );
    if (!query) {
      return { ok: false, reason: "missing_target", message: "需要 model_id / model_name / previous 三者之一" };
    }
    // 1) 完整别名精确匹配（id / 显示名 / 目录名 / 管理器名称）
    var exact = list.filter(function (model) {
      return modelAliases(model).indexOf(query) !== -1;
    });
    if (exact.length === 1) return { ok: true, model: exact[0], matchedBy: "exact" };
    if (exact.length > 1) {
      return { ok: false, reason: "ambiguous", message: "「" + query + "」匹配到多个模型，请用 model_id 精确指定", candidates: exact.slice(0, 8).map(modelCandidate) };
    }
    // 2) 游戏名级匹配：只说游戏名时不要误挑该游戏里的第一个模型，而是返回候选让 AI 追问/指定
    var gameMatches = list.filter(function (model) {
      var game = normalizeModelQuery(model.game);
      return game && (game === query || game.indexOf(query) === 0);
    });
    if (gameMatches.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: "「" + query + "」对应 " + gameMatches.length + " 个模型，请用 model_id 或更具体的模型名（如 k04_kijoui_ani）指定",
        candidates: gameMatches.slice(0, 8).map(modelCandidate)
      };
    }
    // 3) 包含匹配：按空格分词，每个词都要命中；名称 > 场景语义（标签/描述/关键词）> 游戏名
    var tokens = query.split(" ").filter(Boolean);
    var contains = [];
    list.forEach(function (model) {
      var nameText = [model.id, model.name, model.display_name, model.dir].filter(Boolean).join(" ").toLowerCase();
      var semanticText = [model.scene_label, model.category, model.description, model.when_to_use]
        .concat(Array.isArray(model.keywords) ? model.keywords : [])
        .filter(Boolean).join(" ").toLowerCase();
      var gameText = String(model.game || "").toLowerCase();
      var allText = nameText + " " + semanticText + " " + gameText;
      var allHit = tokens.every(function (token) { return allText.indexOf(token) !== -1; });
      if (!allHit) return;
      var score = 0;
      tokens.forEach(function (token) {
        if (nameText.indexOf(token) !== -1) score += nameText.indexOf(token) === 0 ? 60 : 40;
        else if (semanticText.indexOf(token) !== -1) score += 30;
        else score += 20;
      });
      contains.push({ model: model, score: score });
    });
    contains.sort(function (a, b) { return b.score - a.score; });
    if (!contains.length) {
      return { ok: false, reason: "not_found", message: "找不到模型「" + query + "」，可先调用 list_models 查询可用模型", candidates: [] };
    }
    var topScore = contains[0].score;
    var top = contains.filter(function (item) { return item.score === topScore; });
    if (top.length === 1) return { ok: true, model: top[0].model, matchedBy: "contains" };
    return {
      ok: false,
      reason: "ambiguous",
      message: "「" + query + "」匹配到多个模型，请用 model_id 精确指定，或说得更具体",
      candidates: top.slice(0, 8).map(function (item) { return modelCandidate(item.model); })
    };
  }

  // 场景/动作/换装/饰品/模型类工具：由「AI 自动切场景」开关统一控制
  function buildSceneTools(caps, tools) {
    var sceneIds = (caps.scenes || []).filter(function (scene) { return !scene.experimental; }).map(function (scene) { return scene.id; });
    var catalogIds = (caps.catalog_scenes || []).map(function (entry) { return entry.scene_id; });
    var allSceneIds = sceneIds.concat(catalogIds.filter(function (id) { return sceneIds.indexOf(id) === -1; }));
    if (allSceneIds.length) {
      tools.push({
        type: "function",
        function: {
          name: "play_scene",
          description: "播放场景：可传当前模型的场景 id（如 idle/mood_shy/undress），" +
            "也可传场景目录中的 model_id 来切换模型并播放其代表场景（如 R08_kouhai_ani=后背位、R02_danmen=剖面、R03_cushion_ani=抱枕）。" +
            "用户语义上想要某个场景/视角时使用；实验性半脱场景（experimental）不通过此工具自动播放。",
          parameters: {
            type: "object",
            properties: {
              scene_id: {
                type: "string",
                enum: allSceneIds,
                description: "场景 id：" + (caps.scenes || []).filter(function (s) { return !s.experimental; }).map(function (scene) { return scene.id + "=" + scene.label; }).join("，") +
                  (catalogIds.length ? "；或场景目录 model_id（见 system prompt 场景目录，如 lib-tyrano-… / tachie-ani）" : "")
              }
            },
            required: ["scene_id"],
            additionalProperties: false
          }
        }
      });
    }
    tools.push({
      type: "function",
      function: {
        name: "list_motions",
        description: "列出当前模型可用的动作名（当需要精确播放某个动作而不知道名字时先调用）。",
        parameters: {
          type: "object",
          properties: {
            prefix: { type: "string", description: "可选动作名前缀过滤，如 OP_ / tFRM_ / Q_ / zED_" }
          },
          additionalProperties: false
        }
      }
    });
    tools.push({
      type: "function",
      function: {
        name: "play_motion",
        description: "播放一个具体动作。可按动作名（推荐，来自 list_motions 或能力清单 examples）或 group+index 指定。",
        parameters: {
          type: "object",
          properties: {
            motion_name: { type: "string", description: "动作名（不含 .mtn / .motion3.json 后缀），如 OP_014_voice" },
            group: { type: "string", description: "动作组（通常为空字符串）" },
            index: { type: "integer", minimum: 0, description: "动作在组内的下标（与 motion_name 二选一）" }
          },
          additionalProperties: false
        }
      }
    });
    if ((caps.catalog_scenes || []).length) {
      tools.push({
        type: "function",
        function: {
          name: "list_scenes",
          description: "列出场景目录（63 个模型对应的可切换场景）：包含场景 id、游戏/角色、场景名、用途描述、何时该调用、是否 NSFW 限定。不知道有哪些场景或需要按描述挑场景时先调用。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "可选过滤词（场景名/描述/游戏名，如 后位、剖面、抱枕、接吻）" }
            },
            additionalProperties: false
          }
        }
      });
    }
    if (caps.clothing) {
      tools.push({
        type: "function",
        function: {
          name: "set_clothing",
          description: "设置角色服装状态（换装）：0=穿好，最大值=全裸，中间值为衣服淡出的过渡状态（半脱为启发式参数插值，非官方素材，默认不要主动使用）。仅在用户要求脱衣/穿衣/半脱时使用。",
          parameters: {
            type: "object",
            properties: {
              level: {
                type: "number",
                minimum: Number(caps.clothing.min),
                maximum: Number(caps.clothing.max),
                description: "服装等级：" + caps.clothing.min + "=穿好，" + caps.clothing.max + "=全裸，中间值为启发式半脱（参数 " + caps.clothing.param + "）"
              }
            },
            required: ["level"],
            additionalProperties: false
          }
        }
      });
    }
    var accessories = caps.accessories || [];
    if (accessories.length) {
      tools.push({
        type: "function",
        function: {
          name: "set_accessory",
          description: "戴上或摘下当前模型的饰品（如眼镜）。",
          parameters: {
            type: "object",
            properties: {
              accessory_id: { type: "string", enum: accessories.map(function (item) { return item.id; }) },
              on: { type: "boolean", description: "true=戴上，false=摘下" }
            },
            required: ["accessory_id", "on"],
            additionalProperties: false
          }
        }
      });
    }
    if ((caps.models || []).length > 1) {
      tools.push({
        type: "function",
        function: {
          name: "list_models",
          description: "列出/搜索可切换的桌宠模型（角色/场景模型）。返回每个模型的 id、名称、所属游戏、场景语义标签/描述、是否当前选中。用户用自然语言描述想看什么（如「后背位」「口交」「接吻」「剖面」「换回日常立绘」）但不确定对应哪个模型时先调用；switch_model 本身也能按这些语义词模糊匹配。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "可选过滤词（模型名/目录名/游戏名/场景关键字，如 k04、tachie、骑乘、初冬暖阳）" },
              game: { type: "string", description: "可选，只返回某个游戏的模型" },
              limit: { type: "integer", minimum: 1, maximum: 80, description: "最多返回多少个（默认 80）" }
            },
            additionalProperties: false
          }
        }
      });
      var currentModel = null;
      var previousModel = caps.previous_model || null;
      for (var mi = 0; mi < caps.models.length; mi += 1) {
        if (caps.models[mi].selected) { currentModel = caps.models[mi]; break; }
      }
      tools.push({
        type: "function",
        function: {
          name: "switch_model",
          description: "切换桌宠当前展示的模型（换角色/换场景模型）。用户明确说「换成/切到/切换到 …模型」「换回上一个」「切回刚才那个」，或用自然语言描述想看的内容（如「换成后背位的场景」「想看接吻」「换回日常立绘」）时调用。应理解用户意思去匹配，不要要求用户先说出模型文件名。可用 model_id 精确指定；只知道名字/场景/姿势/游戏时用 model_name 模糊匹配（也支持「骑乘」「手交」这类场景语义）；用户说换回去时 previous=true。不要解释工具或内部 id，调用后用一两句话自然回应。" +
            "当前模型：" + (currentModel ? (currentModel.display_name || currentModel.name) + "（id=" + currentModel.id + "）" : "未知") + "；" +
            "上一个模型：" + (previousModel ? (previousModel.display_name || previousModel.name) + "（id=" + previousModel.id + "）" : "无") + "。" +
            "场景目录中 kind=auxiliary 的剖面/辅助模型必须 NSFW 开启且用户明确要求内部视角，SFW 下禁止切换。",
          parameters: {
            type: "object",
            properties: {
              model_id: { type: "string", description: "目标模型的精确 id（如 lib-tyrano-13cmx1o）；不知道 id 时改用 model_name" },
              model_name: { type: "string", description: "目标模型名称/关键字（如 k04_kijoui_ani、tachie_ani、骑乘位、初冬暖阳R）；支持模糊匹配" },
              previous: { type: "boolean", description: "true=切回上一个模型（用户说换回去/切回刚才那个时）" }
            },
            additionalProperties: false
          }
        }
      });
    }
  }

  // 对外工具集合：场景类工具受 scene_ai_enabled 控制；缩放工具独立受 scale.controllable 控制。
  // 两者都关闭时返回空数组（main.js 据此不再开启 function calling）。
  function buildTools(caps) {
    if (!caps) return [];
    var tools = [];
    // 兼容旧版 caps（无 scene_ai_enabled 字段时按开启处理，保持原有行为）
    if (caps.scene_ai_enabled !== false) buildSceneTools(caps, tools);
    if (caps.scale && caps.scale.controllable) {
      var currentPercent = Number(caps.scale.percent);
      if (!isFinite(currentPercent)) currentPercent = 100;
      tools.push({
        type: "function",
        function: {
          name: "set_scale",
          description: "直接设置桌宠缩放百分比（调大/调小桌宠）。用户要求「变大 / 变小 / 放大一点 / 缩小一点 / 缩到某个大小」时调用；用户没有要求调整大小时不要调用。",
          parameters: {
            type: "object",
            properties: {
              percent: {
                type: "integer",
                minimum: 25,
                maximum: 200,
                description: "目标缩放百分比，当前 " + currentPercent + "%，允许范围 25~200"
              }
            },
            required: ["percent"],
            additionalProperties: false
          }
        }
      });
    }
    return tools;
  }

  function buildBrief(caps) {
    if (!caps) return "";
    var lines = [];
    // 场景/动作/换装说明只在「AI 自动切换场景」开启时注入，避免关闭后仍引导模型调用工具
    if (caps.scene_ai_enabled !== false) {
      lines.push("【当前模型能力（AI 可精确操控）】", "当前模型：" + caps.model_name + "（id=" + caps.model_id + "）。");
      var current = caps.current_catalog_entry;
      if (current) {
        lines.push("当前场景/模型语义：" + current.scene_label + "（" + current.category + "，" + current.kind + (current.nsfw_only ? "，NSFW限定" : "") + "）。" + current.description);
        lines.push("何时切换到它/使用它：" + current.when_to_use);
      }
      if (caps.scenes && caps.scenes.length) {
        lines.push("当前模型的场景（play_scene，play_scene 也可传场景目录里的 scene_id 直接切场景）：");
        caps.scenes.forEach(function (scene) {
          lines.push("- " + scene.id + "：" + scene.label + "（" + scene.category + "）" +
            (scene.experimental ? "【实验性·启发式，非官方素材，不要自动选】" : "") +
            (scene.description ? "；" + scene.description : ""));
        });
      }
      if (caps.catalog_scenes && caps.catalog_scenes.length > 1) {
        lines.push("场景目录共有 " + caps.catalog_scenes.length + " 个可切换场景（完整描述+whenToUse 见 system prompt 场景目录；不知道时可调用 list_scenes）：" +
          caps.catalog_scenes.slice(0, 10).map(function (entry) { return entry.scene_label + "(" + entry.scene_id + ")"; }).join("、") + (caps.catalog_scenes.length > 10 ? " 等" : ""));
      }
      // 模型切换：给 AI 一份「模型名 → id」目录，否则用户说 k04_kijoui_ani 时模型无法映射到 id
      if (caps.models && caps.models.length > 1) {
        var currentModel = null;
        for (var mi = 0; mi < caps.models.length; mi += 1) {
          if (caps.models[mi].selected) { currentModel = caps.models[mi]; break; }
        }
        var previousModel = caps.previous_model;
        lines.push("【模型切换（switch_model / list_models）】当前模型：" +
          (currentModel ? (currentModel.display_name || currentModel.name) + "（id=" + currentModel.id + "）" : caps.model_name + "（id=" + caps.model_id + "）") +
          "；上一个模型：" + (previousModel ? (previousModel.display_name || previousModel.name) + "（id=" + previousModel.id + "）" : "无") + "。");
        lines.push("用户说「换成/切到 XXX」「换回上一个」「切回刚才那个」时调用 switch_model：知道 id 传 model_id，只知道名字传 model_name（支持模糊匹配），换回去传 previous=true；拿不准名称先调用 list_models。用户用自然语言描述想看什么（如「后背位」「接吻」「剖面」「日常立绘」）时，也直接用这些语义词作为 model_name 调用，不要要求用户先说模型文件名。");
        var byGame = {};
        caps.models.forEach(function (model) {
          var game = model.game || "未分组";
          if (!byGame[game]) byGame[game] = [];
          byGame[game].push((model.display_name || model.name) + "=" + model.id);
        });
        lines.push("可切换模型（模型名=id，按游戏分组）：");
        Object.keys(byGame).forEach(function (game) {
          lines.push("- " + game + "（" + byGame[game].length + "）：" + byGame[game].join("，"));
        });
      }
      if (caps.clothing) {
        lines.push("服装（set_clothing）：" + caps.clothing.param + " 范围 " + caps.clothing.min + "~" + caps.clothing.max +
          "，其中 " + caps.clothing.dressedValue + "=穿好，" + caps.clothing.nudeValue + "=全裸；中间值的半脱是启发式插值（非官方素材），默认不要主动调用。");
      }
      if (caps.accessories && caps.accessories.length) {
        lines.push("饰品（set_accessory）：" + caps.accessories.map(function (item) { return item.id + "=" + item.label; }).join("，") + "。");
      }
      if (caps.motions && caps.motions.total) {
        lines.push("模型共有 " + caps.motions.total + " 个动作；不知道动作名时可先调用 list_motions（可按前缀 " + (caps.motions.prefixes || []).join("/") + " 过滤），再用 play_motion 精确播放。");
        if (caps.motions.examples && caps.motions.examples.length) {
          lines.push("动作示例：" + caps.motions.examples.slice(0, 12).join("、") + "。");
        }
      }
      lines.push("调用规则：用户明确要求换模型/换角色/换姿势/换场景/脱衣/穿衣/戴摘眼镜/看某个视角（剖面/抱枕/后位等）时，优先调用对应工具（换模型/换场景模型用 switch_model，按语义理解即可，不要让用户报文件名）；调用后只用一两句话自然回应，不要解释工具、参数或内部名称。用户没有相关要求时不要调用工具。" +
        (caps.sfw_active ? "当前 SFW 毛玻璃开启：NSFW 限定场景与辅助剖面模型不可用；用户要求时请提示先开启 NSFW，不要强行调用。" : ""));
    }
    // 缩放说明独立于场景开关：只要管理页允许 AI 控制缩放就注入（用户要求变大/变小时才调用）
    if (caps.scale && caps.scale.controllable) {
      var percent = Number(caps.scale.percent);
      if (!isFinite(percent)) percent = 100;
      var min = Number(caps.scale.min);
      if (!isFinite(min)) min = 25;
      var max = Number(caps.scale.max);
      if (!isFinite(max)) max = 200;
      lines.push("桌宠缩放：当前 " + percent + "%，可调用 set_scale 调整 " + min + "%~" + max + "%（用户要求变大/变小时才调用）。");
    }
    return lines.join("\n");
  }

  window.PetAiControl = {
    buildCapabilities: buildCapabilities,
    buildTools: buildTools,
    buildBrief: buildBrief,
    resolveModelTarget: resolveModelTarget
  };
})();
