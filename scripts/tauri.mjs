// tauri 的入口：读本机配置后执行 tauri 命令，只和本机有关的构建设置都不进仓库
// 三处来源，后面的优先：
// - .env：几台机器共用的一份，pnpm env:seal 加密进 secrets/，别的机器 pnpm env:open 解出来
// - .env.local：只属于这台机器，不加密、不共享（比如这台的签名证书名）
// - shell 里 export 的同名变量
// 能配的：
// - 频道配置 FOX_SYNC_DEFAULT_*：注入 Rust（option_env!），值不打印
// - FOX_SYNC_CARGO_MIRROR：crates 镜像（比如 sparse+https://rsproxy.cn/index/），不填走官方 crates.io
// - APPLE_SIGNING_IDENTITY：签名身份，每台机器不同，放 .env.local。不填时钥匙串里有 Apple Development 证书就用它，
//   没有就临时签名（ad-hoc）。macOS 按签名身份记住授权，临时签名每次构建都不同，重装后可能要重新授权
// 用法：node scripts/tauri.mjs dev | build --bundles app [...]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

function read(name) {
  const file = new URL(`../${name}`, import.meta.url)
  if (!existsSync(file)) return null
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
const shared = read('.env')
if (!shared)
  console.warn(
    '[tauri] 没有 .env，本次不内置频道配置，只能手动配对；有密钥的话先运行 pnpm env:open',
  )
const nonEmpty = (o) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== ''))
const env = {
  ...nonEmpty(shared),
  ...nonEmpty(read('.env.local')),
  ...nonEmpty(process.env),
}

const args = process.argv.slice(2)
const building = args[0] === 'build'

if (building && !env.APPLE_SIGNING_IDENTITY) {
  // 有多张 Apple Development 证书时按名字开头匹配会撞名，取第一张的全名
  const list = execFileSync(
    'security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  )
  const name = list.match(/"(Apple Development[^"]*)"/)?.[1]
  env.APPLE_SIGNING_IDENTITY = name ?? '-'
  console.log(
    name
      ? '[tauri] 用钥匙串里的 Apple Development 证书签名'
      : '[tauri] 钥匙串里没有 Apple Development 证书，临时签名；重装后可能要重新授权，想固定身份就建一张自签名的代码签名证书，名字填进 .env.local 的 APPLE_SIGNING_IDENTITY',
  )
}

if (env.FOX_SYNC_CARGO_MIRROR) {
  // tauri 把 -- 之后的参数交给 cargo
  if (!args.includes('--')) args.push('--')
  args.push(
    '--config',
    'source.crates-io.replace-with="mirror"',
    '--config',
    `source.mirror.registry="${env.FOX_SYNC_CARGO_MIRROR}"`,
  )
}

// 经 pnpm 运行时 tauri 在 PATH 里，直接 node scripts/tauri.mjs 时不在，用项目里装的那份
const local = new URL('../node_modules/.bin/tauri', import.meta.url)
const tauri = existsSync(local) ? local.pathname : 'tauri'
const child = spawn(tauri, args, { stdio: 'inherit', env, shell: false })
child.on('error', (e) => {
  console.error(`[tauri] 启动不了 tauri：${e.message}，先运行 pnpm install`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
