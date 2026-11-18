import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
)
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    tailwind(),
    {
      // 调试探针与 Web 模拟只在 DEV 动态加载，正式包里出现就让构建失败
      name: 'exclude-dev-modules',
      apply: 'build',
      generateBundle(_, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue
          for (const [id, module] of Object.entries(output.modules)) {
            if (id.includes('/src/debug/') && module.renderedLength > 0)
              this.error(`生产构建包含调试模块：${id}`)
          }
        }
        console.log('生产边界检查通过：无 src/debug 模块')
      },
    },
  ],
  server: {
    port: 5186,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  clearScreen: false,
})
