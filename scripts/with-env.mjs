// 读取 .env 后执行命令，构建时把默认令牌和密钥注入 Rust（option_env!），值不打印
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const file = new URL('../.env', import.meta.url)
const env = { ...process.env }
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
} else {
  console.warn(
    '[with-env] 没有 .env，先运行 pnpm env:open；本次不内置令牌和密钥',
  )
}
const [command, ...args] = process.argv.slice(2)
const child = spawn(command, args, { stdio: 'inherit', env, shell: false })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
