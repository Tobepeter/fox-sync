// 页面和抽屉都放在 hash 地址里（wouter 的 hash 模式）：刷新停在原处，浏览器里能直接打开、前进后退
// #/folders、#/folders/<文件夹 ID>、#/folders/new、#/folders/join/<文件夹 ID>、#/devices、#/devices/<设备 ID>、#/settings、#/debug
// 不依赖 import.meta，供 node --test 直接测试

export type Route = {
  page: string
  /** 文件夹或设备详情抽屉 */
  detail: { kind: 'folder' | 'device'; id: string } | null
  /** 新建或加入抽屉：join 是要加入的文件夹 ID，新建为 null */
  form: { join: string | null } | null
}

/** 解析 hash 路径；认不出的页面回到文件夹页。pages 是这个版本有的页面（调试页只在开发版） */
export function parseRoute(path: string, pages: readonly string[]): Route {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  const page = pages.includes(parts[0] ?? '') ? parts[0] : 'folders'
  const none: Route = { page, detail: null, form: null }
  if (page === 'folders') {
    if (parts[1] === 'new') return { ...none, form: { join: null } }
    if (parts[1] === 'join' && parts[2])
      return { ...none, form: { join: parts[2] } }
    if (parts[1]) return { ...none, detail: { kind: 'folder', id: parts[1] } }
  }
  if (page === 'devices' && parts[1])
    return { ...none, detail: { kind: 'device', id: parts[1] } }
  return none
}

export function detailPath(d: { kind: 'folder' | 'device'; id: string }) {
  return `/${d.kind === 'folder' ? 'folders' : 'devices'}/${encodeURIComponent(d.id)}`
}

export function formPath(join: string | null) {
  return join ? `/folders/join/${encodeURIComponent(join)}` : '/folders/new'
}
