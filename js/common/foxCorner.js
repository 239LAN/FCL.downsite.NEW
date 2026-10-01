/**
 * 页尾吉祥物插画
 * 用于在每个页面的正文最底部追加一张"趴在墙上"的狐狸插画（靠右对齐）。
 * 纯装饰元素：不参与交互、不进入无障碍树，也不脱离文档流、不遮挡任何内容。
 * 图片为带透明通道的 AVIF，因此白天/夜间主题与 RTL 方向下都无需换图。
 */

/** 图片路径。宽度由 css/xf.css 中的 --xf-fox-corner-width 决定。 */
const IMAGE_SRC = '/media/img/fox-corner.avif';

/** 元素 id。同时被 css/xf.css 与 css/rtl.css 选择，改名需同步。 */
const CONTAINER_ID = 'xf-foxCorner';

/**
 * 查找正文容器：body 下除顶栏、抽屉与 Toast 容器外的最后一个 div。
 * 本站各页正文都包在一层无 class 的匿名 div 里，插画追加到它末尾即为正文最底部。
 * @returns {HTMLElement} 正文容器；找不到时退化为 body
 */
function findContentContainer() {
  const candidates = Array.from(document.body.children).filter((el) =>
    el.tagName === 'DIV'
    && !el.classList.contains('mdui-appbar')
    && !el.classList.contains('mdui-drawer')
    && !el.classList.contains('toast-container')
  );
  return candidates.length > 0 ? candidates[candidates.length - 1] : document.body;
}

document.addEventListener('DOMContentLoaded', function () {
  // 页面重复引入 common.js 时不重复创建。
  if (document.getElementById(CONTAINER_ID)) return;

  const img = document.createElement('img');
  img.id = CONTAINER_ID;
  img.src = IMAGE_SRC;
  // 纯装饰：空 alt + aria-hidden，避免读屏软件朗读；pointer-events 由 CSS 关闭。
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  // 图片缺失时不要留下破图占位（浏览器对空 alt 的破图渲染各版本不一致）。
  img.addEventListener('error', function () {
    img.remove();
  });

  findContentContainer().appendChild(img);
});
