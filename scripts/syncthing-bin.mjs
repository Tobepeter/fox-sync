// 准备内置的 Syncthing：只取 Apple 芯片（arm64）那一份，放到 src-tauri/binaries/，打包时作为 externalBin 随应用签名
// 来源优先用本机官方构建的 Syncthing.app（Kastelo 签名），其次 brew；版本和 VERSION 不一致时报错，避免悄悄换版本
// 二进制不进仓库（.gitignore），新机器上运行一次本脚本即可；已是目标版本时直接跳过
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'

const VERSION = 'v2.1.6'
const out = 'src-tauri/binaries/syncthing-aarch64-apple-darwin'
const license = 'src-tauri/binaries/syncthing-LICENSE.txt'
const sources = [
  {
    bin: '/Applications/Syncthing.app/Contents/Resources/syncthing/syncthing',
    license:
      '/Applications/Syncthing.app/Contents/Resources/syncthing/LICENSE.txt',
  },
  { bin: '/opt/homebrew/bin/syncthing', license: null },
]

const version = (bin) =>
  execFileSync(bin, ['--version'], { encoding: 'utf8' }).split(' ')[1]

if (existsSync(out) && existsSync(license) && version(out) === VERSION)
  process.exit(0)

const source = sources.find((s) => existsSync(s.bin))
if (!source) {
  console.error(
    `[syncthing-bin] 本机没有 Syncthing.app 或 brew 的 syncthing，装一个 ${VERSION} 再运行`,
  )
  process.exit(1)
}
const found = version(source.bin)
if (found !== VERSION) {
  console.error(
    `[syncthing-bin] ${source.bin} 是 ${found}，内置版本定的是 ${VERSION}；升级时改脚本里的 VERSION`,
  )
  process.exit(1)
}
mkdirSync('src-tauri/binaries', { recursive: true })
const archs = execFileSync('lipo', ['-archs', source.bin], { encoding: 'utf8' })
  .trim()
  .split(' ')
if (archs.length > 1)
  execFileSync('lipo', [source.bin, '-thin', 'arm64', '-output', out])
else copyFileSync(source.bin, out)
chmodSync(out, 0o755)
if (source.license) copyFileSync(source.license, license)
else if (!existsSync(license)) {
  console.error(
    '[syncthing-bin] 没找到 Syncthing 的 LICENSE.txt（MPL-2.0），从 Syncthing.app 或官方发布包里拷一份到',
    license,
  )
  process.exit(1)
}
console.log(`[syncthing-bin] 已准备 ${out}（${VERSION}，来自 ${source.bin}）`)
