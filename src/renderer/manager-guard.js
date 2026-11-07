// 管理页渲染兜底（2026-11 用户反馈：管理窗左侧内容被裁、右侧出现深色空白）
// 根因：Chromium 页面缩放被改成 125%（Ctrl+滚轮 / 系统 DPI 变化，且缩放会被持久化），
// 布局视口只剩约 772 CSS px，而窗口按 966 px 绘制 → 右侧区域不重绘、内容被横向滚走。
// 本脚本只在管理页生效：
//   1) 拦截 Ctrl+滚轮，禁止页面缩放；
//   2) 加载/窗口尺寸变化后检测 outerWidth/innerWidth 比例，异常时通过 preload 复位 100%；
//   3) 修正完成后派发 resize 让现有渲染逻辑重新布局。
(function () {
  "use strict";
  var view = "";
  try {
    view = new URLSearchParams(location.search).get("view") || "";
  } catch (e) {
    view = "";
  }
  if (view !== "manager") return;

  window.addEventListener(
    "wheel",
    function (event) {
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { passive: false }
  );

  function zoomLooksWrong() {
    // 100% 无缩放时 outerWidth 只比 innerWidth 多窗口边框（约 15px）；
    // 125% 缩放时比例约 1.27，>1.08 即视为异常。
    if (!window.innerWidth || !window.outerWidth) return false;
    return window.outerWidth / window.innerWidth > 1.08;
  }

  var lastFixAt = 0;
  function ensureZoom() {
    if (!zoomLooksWrong()) return;
    var now = Date.now();
    if (now - lastFixAt < 1200) return;
    lastFixAt = now;
    try {
      if (window.daidaiPet && typeof window.daidaiPet.resetManagerZoom === "function") {
        window.daidaiPet.resetManagerZoom().then(function () {
          window.dispatchEvent(new Event("resize"));
        });
      }
    } catch (e) {}
  }

  window.addEventListener("load", function () {
    setTimeout(ensureZoom, 300);
  });
  window.addEventListener("resize", function () {
    setTimeout(ensureZoom, 200);
  });
})();
