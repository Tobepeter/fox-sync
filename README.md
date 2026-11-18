# FoxSync

macOS 桌面端：内置 Syncthing 并替代它的网页管理页，经 ntfy 加密频道让自己的几台电脑自动互相发现、一键加入文件夹。同步本身由 Syncthing 完成

```bash
pnpm env:open      # 从 secrets/ 解出 .env（本机配置），要对应的 age 私钥；没有就照 .env.example 自己建
pnpm dev           # 桌面开发版，Vite 5186，探针 5196
pnpm dev:web       # 浏览器 Web 模拟
pnpm probe -- snapshot
pnpm probe -- simulate stopped
pnpm test
pnpm install:app   # 打包并覆盖安装到 /Applications
```

Syncthing（arm64，v2.1.6）随 FoxSync 一起打包，由 FoxSync 拉起和关闭，沿用 `~/Library/Application Support/Syncthing` 的配置。`pnpm dev` 前会从本机 Syncthing.app 或 brew 里取出二进制（`scripts/syncthing-bin.mjs`）。Syncthing.app 或 brew 的 Syncthing 正在运行时，FoxSync 会提示接管

## 本机配置

只和本机有关的构建设置都不提交，说明见 `.env.example`。`.env` 是几台机器共用的一份（加密进 `secrets/`），`.env.local` 只属于这台机器、优先于 `.env`，shell 里 export 的同名变量再优先：

- **频道**：`FOX_SYNC_DEFAULT_*`，构建时写进程序。`secrets/env.sops.yaml` 是作者自己的加密配置，没有对应 age 私钥的话，复制 `.env.example` 成 `.env` 填自己的 ntfy 服务器，或者留空只用手动配对
- **crates 镜像**：`FOX_SYNC_CARGO_MIRROR`，不填走官方 crates.io
- **签名**：`APPLE_SIGNING_IDENTITY`，每台机器不同，放 `.env.local`。不填时钥匙串里有 Apple Development 证书就用它，没有就临时签名。macOS 按签名身份记住授权（本地网络、访问文件夹），临时签名每次构建都不同，重装后可能要重新授权；想固定身份又没有开发者账号，可以在“钥匙串访问 → 证书助理 → 创建证书”里建一张类型为“代码签名”的自签名证书，把名字填进来

## 头像版权

头像由 [DiceBear](https://www.dicebear.com/) 生成，大部分风格为 CC0 或作者声明可免费使用。以下风格按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用：Adventurer（Lisa Wischofsky）、Big Ears（The Visual Team）、Big Smile（Ashley Seo）、Croodles（vijay verma）、Dylan（Natalia Spivak）、Fun Emoji（Davis Uche）、Micah（Micah Lanier）、Miniavs（Webpixels）、Personas（Draftbit）、Toon Head（Johan Melin）
