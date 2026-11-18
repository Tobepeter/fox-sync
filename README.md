# FoxSync

macOS 桌面端：内置 Syncthing 并替代它的网页管理页，经 ntfy 加密频道让自己的几台电脑自动互相发现、一键加入文件夹。同步本身由 Syncthing 完成

```bash
pnpm env:open      # 从 secrets/ 解出 .env（频道配置），要本机的 age 私钥
pnpm dev           # 桌面开发版，Vite 5186，探针 5196
pnpm dev:web       # 浏览器 Web 模拟
pnpm probe -- snapshot
pnpm probe -- simulate stopped
pnpm test
pnpm install:app   # 打包并覆盖安装到 /Applications
```

Syncthing（arm64，v2.1.6）随 FoxSync 一起打包，由 FoxSync 拉起和关闭，沿用 `~/Library/Application Support/Syncthing` 的配置。`pnpm dev` 前会从本机 Syncthing.app 或 brew 里取出二进制（`scripts/syncthing-bin.mjs`）。Syncthing.app 或 brew 的 Syncthing 正在运行时，FoxSync 会提示接管

## 头像版权

头像由 [DiceBear](https://www.dicebear.com/) 生成，大部分风格为 CC0 或作者声明可免费使用。以下风格按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用：Adventurer（Lisa Wischofsky）、Big Ears（The Visual Team）、Big Smile（Ashley Seo）、Croodles（vijay verma）、Dylan（Natalia Spivak）、Fun Emoji（Davis Uche）、Micah（Micah Lanier）、Miniavs（Webpixels）、Personas（Draftbit）、Toon Head（Johan Melin）
