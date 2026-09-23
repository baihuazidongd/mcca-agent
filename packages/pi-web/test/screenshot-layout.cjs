/* 截右栏 + 设置菜单验证布局。代理用的浏览器不再带 Playwright，这个临时脚本要自己装。 */
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("这个临时布局脚本需要单独安装 playwright，代理浏览器不再依赖它。");
  process.exit(1);
}
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto("http://127.0.0.1:3458/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  // 打开设置菜单看图片功能子区
  await page.click("#btn-settings-menu");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test/layout-check-settings.png" });
  await page.click("#btn-settings-menu");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test/layout-check.png" });
  await browser.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
