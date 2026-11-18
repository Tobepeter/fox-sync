// 桌面开发版探针：把表达式发给 Rust 的本机调试入口，在主窗口求值后输出 JSON
// d 指代 window.__DEBUG__，常用：snapshot、simulate、refresh、navigate
const port = process.env.FOX_SYNC_PROBE_PORT || 5196
const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'))
const [command = 'snapshot', ...rest] = argv
const text = rest.join(' ')
const app = 'd.sync.app'
const expressions = {
  snapshot: `${app}.snapshot()`,
  ready: `${app}.ready()`,
  eval: text,
  // 模拟 Syncthing 状态：starting / occupied / failed / stopped / error，不带参数恢复真实状态
  simulate: `${app}.actions.simulate(${JSON.stringify(text)})`,
  refresh: `(async () => { await ${app}.actions.refresh(); return ${app}.snapshot() })()`,
  navigate: `(async () => { ${app}.actions.navigate(${JSON.stringify(text || 'folders')}); return ${app}.snapshot() })()`,
  reload: `(setTimeout(() => location.reload(), 50), true)`,
}
const expression = expressions[command]
if (!expression) {
  console.error(
    `未知命令 ${command}，可用：${Object.keys(expressions).join(' ')}`,
  )
  process.exit(2)
}
try {
  const response = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: 'POST',
    body: expression,
  })
  const result = await response.json()
  console.log(
    JSON.stringify(result.ok ? result.value : { error: result.error }, null, 2),
  )
  process.exit(result.ok ? 0 : 1)
} catch (e) {
  console.error(
    `连不上探针（127.0.0.1:${port}），先运行 pnpm dev：${e.message}`,
  )
  process.exit(1)
}
