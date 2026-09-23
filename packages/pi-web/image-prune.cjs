"use strict";

/**
 * 历史图片裁剪扩展：每次 LLM 调用前，把过旧的图片块换成一行说明文字。
 *
 * 背景：截图类工具会把 base64 原图写进分支，一个会话攒几十张就是几十 MB。
 * provider 网关会因请求体过大直接 413（且重试只会一直失败，退避还一次比一次长）。
 * 图片按「只留最近 N 张」裁剪，正文与工具输出只保留文字，请求体回到正常大小。
 *
 * 保留张数可用环境变量覆盖：MCCA_KEEP_RECENT_IMAGES（默认 4）。
 */

const KEEP_RECENT_IMAGES = (() => {
  const raw = Number(process.env.MCCA_KEEP_RECENT_IMAGES);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 4;
})();

const PLACEHOLDER = "[图片已省略：为控制请求体积，历史截图不再随请求发送]";

function isImageBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "image" || block.type === "image_url") return true;
  return Boolean(block.source && block.source.type === "base64");
}

/**
 * 把 messages 里除最近 keep 张之外的图片块替换成说明文字。
 * 只改被裁到的消息（浅拷贝 content），原对象不动。
 * @returns {{messages: any[], dropped: number}}
 */
function pruneMessages(messages, keep) {
  const spots = [];
  for (let mi = 0; mi < messages.length; mi += 1) {
    const m = messages[mi];
    const content = m && Array.isArray(m.content) ? m.content : null;
    if (!content) continue;
    for (let ci = 0; ci < content.length; ci += 1) {
      if (isImageBlock(content[ci])) spots.push([mi, ci]);
    }
  }
  const drop = spots.slice(0, Math.max(0, spots.length - keep));
  if (!drop.length) return { messages, dropped: 0 };
  const next = messages.slice();
  const touched = new Set();
  for (const [mi, ci] of drop) {
    if (!touched.has(mi)) {
      next[mi] = { ...next[mi], content: next[mi].content.slice() };
      touched.add(mi);
    }
    next[mi].content[ci] = { type: "text", text: PLACEHOLDER };
  }
  return { messages: next, dropped: drop.length };
}

/** 创建 pi 扩展工厂：context 钩子里裁剪历史图片（任何异常都放行原始消息）。 */
function createImagePruneExtension(options = {}) {
  const keep = Number.isFinite(options.keep) ? Math.max(0, Math.floor(options.keep)) : KEEP_RECENT_IMAGES;
  return function imagePruneExtension(pi) {
    pi.on("context", (event) => {
      try {
        const messages = Array.isArray(event.messages) ? event.messages : null;
        if (!messages || !messages.length) return undefined;
        const { messages: next, dropped } = pruneMessages(messages, keep);
        if (!dropped) return undefined;
        if (process.env.MCCA_PRUNE_LOG) console.error(`[image-prune] 裁剪历史图片 ${dropped} 张（保留最近 ${keep} 张）`);
        return { messages: next };
      } catch {
        return undefined;
      }
    });
  };
}

module.exports = { createImagePruneExtension, pruneMessages, KEEP_RECENT_IMAGES };
