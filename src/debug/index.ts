// DEBUG：调试探针唯一入口 window.__DEBUG__，按 <space>.<name> 分层，只在 DEV 挂载
export type DebugSurface = {
  ready: () => boolean
  snapshot: () => unknown
  actions?: Record<string, (...args: never[]) => unknown>
}

type DebugSpace = Record<string, unknown>

declare global {
  interface Window {
    __DEBUG__?: Record<string, DebugSpace>
  }
}

const noop = () => {}

export function mountDebug<T>(space: string, name: string, value: T) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return noop
  const root = (window.__DEBUG__ ??= {})
  const ns = (root[space] ??= {})
  ns[name] = value
  return () => {
    if (ns[name] === value) delete ns[name]
  }
}
