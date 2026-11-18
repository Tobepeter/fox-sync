import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIgnores,
  defaultIgnores,
  IGNORE_ITEMS,
} from '../src/lib/ignores.ts'

test('忽略模板：勾上的是规则，没勾的留成注释，自定义去掉空行', () => {
  const text = buildIgnores(['system'], '  *.log \n\n build-cache ')
  const lines = text.split('\n')
  assert.ok(lines.includes('(?d).DS_Store'))
  assert.ok(lines.includes('// node_modules'))
  assert.ok(!lines.includes('node_modules'))
  assert.deepEqual(lines.slice(-3), ['// 自定义', '*.log', 'build-cache'])
  // Syncthing 的注释只能整行写，不能有行尾注释
  for (const line of lines)
    assert.ok(line === '' || line.startsWith('//') || !line.includes('//'))
})

test('忽略模板：默认只勾系统文件和临时文件', () => {
  assert.deepEqual(defaultIgnores(), ['system', 'temp'])
  assert.equal(new Set(IGNORE_ITEMS.map((i) => i.id)).size, IGNORE_ITEMS.length)
})

test('忽略模板：Rust 自动加入用的默认模板和前端生成的一致', async () => {
  const { readFileSync } = await import('node:fs')
  const rust = readFileSync(
    new URL('../src-tauri/src/folders.rs', import.meta.url),
    'utf8',
  )
  const inRust = rust.match(
    /pub const DEFAULT_IGNORES: &str = r#"([\s\S]*?)"#;/,
  )?.[1]
  assert.equal(inRust, buildIgnores(defaultIgnores(), ''))
})
