import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detailPath, formPath, parseRoute } from '../src/lib/route.ts'

const PAGES = ['folders', 'devices', 'settings', 'debug']

test('路由：页面、详情抽屉、新建和加入', () => {
  assert.deepEqual(parseRoute('/', PAGES), {
    page: 'folders',
    detail: null,
    form: null,
  })
  assert.deepEqual(parseRoute('/settings', PAGES), {
    page: 'settings',
    detail: null,
    form: null,
  })
  assert.deepEqual(parseRoute('/folders/k3n9q-x7w2p', PAGES).detail, {
    kind: 'folder',
    id: 'k3n9q-x7w2p',
  })
  assert.deepEqual(parseRoute('/devices/WEBM5AA-X', PAGES).detail, {
    kind: 'device',
    id: 'WEBM5AA-X',
  })
  assert.deepEqual(parseRoute('/folders/new', PAGES).form, { join: null })
  assert.deepEqual(parseRoute('/folders/join/w8r2k', PAGES).form, {
    join: 'w8r2k',
  })
  // 认不出的页面、正式版没有的调试页都回到文件夹
  assert.equal(parseRoute('/nope', PAGES).page, 'folders')
  assert.equal(parseRoute('/debug', ['folders']).page, 'folders')
})

test('路由：生成的地址能解析回来，ID 里的特殊字符会转义', () => {
  const id = 'a b/中'
  assert.equal(
    parseRoute(detailPath({ kind: 'folder', id }), PAGES).detail?.id,
    id,
  )
  assert.equal(parseRoute(formPath(id), PAGES).form?.join, id)
  assert.equal(formPath(null), '/folders/new')
})
