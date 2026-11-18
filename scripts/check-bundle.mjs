// 打包后校验：签名身份是 Apple Development（固定身份，重装后系统授权保留），产物里没有调试入口
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
if (!authority.startsWith('Apple Development')) {
  console.error(
    `签名身份不是 Apple Development：${authority || '无'}，重装后需要重新授权`,
  )
  process.exit(1)
}
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
console.log(`打包检查通过：${path}，签名 Apple Development`)
