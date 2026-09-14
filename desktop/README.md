# pdb 桌面壳（Tauri v2）

这个目录把 portal 包成一个原生窗口：Rust 侧只做「开一个 WebView2 窗口、加载
portal 的 localhost 页面」，业务逻辑全在 `packages/portal`（Node）。dsh / pi /
portal 仍是三个独立进程，一个崩了不影响其它。

**状态：已编译验证通过。** `desktop/src-tauri/target/release/pdb-desktop.exe`
（约 8.5 MB）已生成，窗口渲染、管理面板、从 UI 启停 pi 均已在真机验证。
工具链：rustup + stable-msvc 1.98 + VS 2022 Build Tools（VCTools workload）。

## 构建 / 运行

```bash
node packages/portal/server.cjs        # 1) 先起 portal（:3470）
desktop/src-tauri/target/release/pdb-desktop.exe   # 2) 打开桌面窗口
# 重新编译：
pnpm --filter pdb-desktop tauri build             # 出 .exe + 安装包
pnpm --filter pdb-desktop tauri build --no-bundle # 只出 .exe
```

窗口 URL 配在 `src-tauri/tauri.conf.json` 的 `app.windows[0].url`。图标用
`pnpm tauri icon icon-source.png` 重新生成（`scripts/gen-icon.mjs` 产出源 PNG）。
要系统托盘/文件对话框/单实例锁等能力时，需在 `capabilities/default.json` 补权限。
