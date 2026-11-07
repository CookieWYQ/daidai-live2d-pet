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
      models: (opts.models || []).map(function (model) {
        return { id: model.id, name: model.name, selected: model.id === opts.modelId };
      })
    };
  }

  function buildTools(caps) {
    if (!caps) return [];
    var tools = [];
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
          name: "switch_model",
          description: "切换桌宠当前展示的模型（角色）。只在用户明确要求换角色/换场景时使用；场景目录中 kind=auxiliary 的剖面/辅助模型必须 NSFW 开启且用户明确要求内部视角，SFW 下禁止切换。",
          parameters: {
            type: "object",
            properties: {
              model_id: { type: "string", enum: caps.models.map(function (model) { return model.id; }) }
            },
            required: ["model_id"],
            additionalProperties: false
          }
        }
      });
    }
    return tools;
  }

  function buildBrief(caps) {
    if (!caps) return "";
    var lines = ["【当前模型能力（AI 可精确操控）】", "当前模型：" + caps.model_name + "（id=" + caps.model_id + "）。"];
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
    lines.push("调用规则：用户明确要求换姿势/换场景/脱衣/穿衣/戴摘眼镜/看某个视角（剖面/抱枕/后位等）时，优先调用对应工具；调用后只用一两句话自然回应，不要解释工具、参数或内部名称。用户没有相关要求时不要调用工具。" +
      (caps.sfw_active ? "当前 SFW 毛玻璃开启：NSFW 限定场景与辅助剖面模型不可用；用户要求时请提示先开启 NSFW，不要强行调用。" : ""));
    return lines.join("\n");
  }

  window.PetAiControl = {
    buildCapabilities: buildCapabilities,
    buildTools: buildTools,
    buildBrief: buildBrief
  };
})();
