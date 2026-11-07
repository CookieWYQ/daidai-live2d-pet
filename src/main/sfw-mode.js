// SFW/NSFW 模式解析。
// 产品默认 SFW（模型画面盖毛玻璃遮罩）；托盘菜单可切换 NSFW 清晰并持久化。
// 自动化测试/截图需要清晰画面时，可用启动参数或环境变量“强制 NSFW”，
// 强制只影响本次运行，不写入 config.json，因此不会改变用户保存的选择。
const NSFW_TRUE = new Set(["1", "true", "yes", "on", "nsfw"]);
const NSFW_FALSE = new Set(["0", "false", "no", "off", "sfw"]);

function normalizeFlag(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

// 返回 true=强制 NSFW 清晰；false=强制 SFW 毛玻璃；null=跟随用户配置
function resolveNsfwOverride({ argv = [], env = {} } = {}) {
  const args = (argv || []).map((arg) => String(arg));
  if (args.includes("--nsfw")) return true;
  if (args.includes("--sfw")) return false;

  const nsfwEnv = normalizeFlag(env.DAIDAI_NSFW);
  if (NSFW_TRUE.has(nsfwEnv)) return true;
  if (NSFW_FALSE.has(nsfwEnv)) return false;

  const sfwEnv = normalizeFlag(env.DAIDAI_SFW);
  if (NSFW_TRUE.has(sfwEnv)) return false;
  return null;
}

// 当前生效的是否为 NSFW 清晰画面
function effectiveNsfw(config, override) {
  if (override === true || override === false) return override;
  return Boolean(config && config.nsfwMode === true);
}

// 提供给渲染进程的 SFW 状态（用于叠加/移除毛玻璃遮罩）
function sfwState(config, override) {
  const nsfw = effectiveNsfw(config, override);
  return {
    sfw: !nsfw,
    nsfw,
    // null=跟随用户配置；true/false=启动参数强制（测试用）
    forced: override === true || override === false ? override : null,
    // 用户持久化的选择（不受强制模式影响）
    savedNsfw: Boolean(config && config.nsfwMode === true),
    blur: Math.min(40, Math.max(8, Number((config && config.sfwBlur) || 22)))
  };
}

module.exports = {
  effectiveNsfw,
  resolveNsfwOverride,
  sfwState
};
