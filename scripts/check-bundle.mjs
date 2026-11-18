// 打包后校验：产物里没有调试入口；签名是临时签名（ad-hoc）时提醒，固定身份的证书重装后系统授权保留
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

const dir = 'src-tauri/target/release/bundle/macos'
const app =
  existsSync(dir) && readdirSync(dir).find((name) => name.endsWith('.app'))
if (!app) {
  console.error('没找到打包产物')
  process.exit(1)
}
const path = `${dir}/${app}`
const detail = execFileSync('sh', ['-c', `codesign -dvv "${path}" 2>&1`], {
  encoding: 'utf8',
})
const authority = detail.match(/^Authority=(.*)$/m)?.[1] ?? ''
const adhoc = /^Signature=adhoc$/m.test(detail) || !authority
if (adhoc)
  console.warn(
    '[check-bundle] 临时签名：重装后可能要重新授权；想固定身份见 scripts/tauri.mjs 开头的说明',
  )
const binary = execFileSync(
  'sh',
  [
    '-c',
    `strings "${path}/Contents/MacOS/"* | grep -c -E 'debug_simulate|debug_reply|FOX_SYNC_PROBE_PORT' || true`,
  ],
  { encoding: 'utf8' },
).trim()
if (binary !== '0') {
  console.error(`正式包里还有调试入口字符串 ${binary} 处`)
  process.exit(1)
}
console.log(`打包检查通过：${path}，签名 ${adhoc ? '临时签名' : authority}`)
