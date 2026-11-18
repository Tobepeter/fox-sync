// DEBUG：主窗口业务探针，挂在 __DEBUG__.sync.app；状态由 App 每次渲染后同步进来
import { mountDebug, type DebugSurface } from './index'
import {
  api,
  desktop,
  mockActive,
  type FolderRequest,
  type PendingFolder,
  type SimulateState,
  type Snapshot,
} from '../lib/runtime'

export type AppView = {
  snapshot: Snapshot
  loaded: boolean
  page: string
  setPage: (page: string) => void
  dialog: { open: boolean; joining: PendingFolder | null }
  setDialog: (dialog: { open: boolean; joining: PendingFolder | null }) => void
  detail: { kind: 'folder' | 'device'; id: string } | null
  refresh?: () => Promise<unknown>
  setDetail: (detail: { kind: 'folder' | 'device'; id: string } | null) => void
}

// 一段时间内条件成立就返回，超时报错；给动作“等到目标状态再 resolve”
function until<T>(
  read: () => T | undefined | false,
  timeout = 10000,
  label = '条件',
) {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = read()
      if (value) return resolve(value)
      if (Date.now() - started > timeout)
        return reject(new Error(`等待${label}超时`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

export class AppDebug implements DebugSurface {
  #view: AppView | undefined
  sync(view: AppView) {
    this.#view = view
  }
  #need() {
    if (!this.#view) throw new Error('页面还没渲染')
    return this.#view
  }

  ready = () => !!this.#view?.loaded

  snapshot = () => {
    const v = this.#view
    if (!v) return { ready: false }
    const s = v.snapshot
    const st = s.syncthing
    return {
      ready: v.loaded,
      runtime: desktop ? 'desktop' : 'web',
      mock: mockActive(),
      detail: v.detail,
      page: v.page,
      identity: s.identity,
      settings: s.settings,
      syncthing: {
        state: st.state,
        error: st.error,
        url: st.url,
        version: st.version,
        // 设备 ID 只给短写，探针输出也不带完整 ID
        devices: st.devices.map((d) => ({
          id: d.id.slice(0, 7),
          name: d.name,
          me: d.me,
          connected: d.connected,
          kind: d.kind,
        })),
        folders: st.folders.map((f) => ({
          id: f.id,
          label: f.label,
          path: f.path,
          state: f.state,
          kind: f.kind,
          paused: f.paused,
          devices: f.devices.length,
          needItems: f.needItems,
          conflicts: f.conflicts,
          errorItems: f.errorItems,
          localChanges: f.localChanges,
          versioning: f.versioning,
        })),
        pendingFolders: st.pendingFolders.map((p) => ({
          id: p.id,
          label: p.label,
          offeredBy: p.offeredBy.map((d) => d.slice(0, 7)),
        })),
        pendingDevices: st.pendingDevices.map((d) => ({
          id: d.id.slice(0, 7),
          name: d.name,
          address: d.address,
        })),
      },
      channel: s.channel,
      // 频道里认识的设备，Syncthing 设备 ID 只给短写
      peers: s.peers.map((p) => ({
        id: p.id,
        name: p.name,
        syncthingId: p.syncthingId.slice(0, 7),
        seen: p.seen,
      })),
      autoShare: s.autoShare,
      dialog: { open: v.dialog.open, joining: v.dialog.joining?.id ?? null },
    }
  }

  #pending(id: string) {
    const p = this.#need().snapshot.syncthing.pendingFolders.find(
      (f) => f.id === id,
    )
    if (!p) throw new Error(`没有待加入的文件夹 ${id}`)
    return p
  }
  #device(prefix: string) {
    const d = this.#need().snapshot.syncthing.pendingDevices.find((x) =>
      x.id.startsWith(prefix),
    )
    if (!d) throw new Error(`没有请求连接的设备 ${prefix}`)
    return d
  }
  // 等快照里出现这个文件夹，事件流刷新有几百毫秒延迟
  #folder = (id: string) =>
    until(
      () =>
        this.#view?.snapshot.syncthing.folders.some((f) => f.id === id) &&
        this.snapshot(),
      15000,
      `文件夹 ${id}`,
    )

  actions = {
    navigate: (page: string) => this.#need().setPage(page),
    /** 打开新建对话框；传文件夹 ID 打开加入对话框 */
    openDialog: (id?: string) =>
      this.#need().setDialog({
        open: true,
        joining: id ? this.#pending(id) : null,
      }),
    closeDialog: () => this.#need().setDialog({ open: false, joining: null }),
    /** 打开文件夹详情；设备按 ID 前缀找 */
    openFolder: (id: string) => {
      this.#need().setPage('folders')
      this.#need().setDetail({ kind: 'folder', id })
    },
    openDevice: (prefix: string) => {
      const d = this.#need().snapshot.syncthing.devices.find((x) =>
        x.id.startsWith(prefix),
      )
      if (!d) throw new Error(`没有设备 ${prefix}`)
      this.#need().setPage('devices')
      this.#need().setDetail({ kind: 'device', id: d.id })
    },
    closeDetail: () => this.#need().setDetail(null),
    /** 页面切到模拟状态，同底部 Mock 状态条；target 见 MOCK_STATES */
    mock: async (target: string, state: string, id?: string) => {
      await api.debugMock(target, state, id)
      await new Promise((r) => setTimeout(r, 100))
      return this.snapshot()
    },
    /** 回到原本的数据 */
    restore: async () => {
      await api.debugRestore()
      this.#need().refresh?.()
      await new Promise((r) => setTimeout(r, 200))
      return this.snapshot()
    },
    /** 直接调命令新建，绕过对话框；字段缺省用对话框的默认值 */
    createFolder: async (
      request: Partial<FolderRequest> & { label: string; path: string },
    ) => {
      const id = await api.createFolder({
        id: null,
        kind: 'sendreceive',
        devices: [],
        ignores: '',
        versioning: true,
        autoShare: true,
        ...request,
      })
      return this.#folder(id)
    },
    /** 加入待处理的文件夹，默认放在 ~/FoxSync/<名称> */
    joinFolder: async (id: string, path?: string, kind = 'sendreceive') => {
      const p = this.#pending(id)
      await api.createFolder({
        id,
        label: p.label || id,
        path: path ?? `~/FoxSync/${p.label || id}`,
        kind,
        devices: p.offeredBy,
        ignores: '',
        versioning: true,
        autoShare: true,
      })
      return this.#folder(id)
    },
    ignoreFolder: (id: string) => api.ignoreFolder(this.#pending(id).id),
    acceptDevice: (prefix: string) => api.acceptDevice(this.#device(prefix).id),
    ignoreDevice: (prefix: string) => api.ignoreDevice(this.#device(prefix).id),
    refresh: () => api.refreshSyncthing(),
    /** 模拟 Syncthing 状态看界面，空串恢复 */
    simulate: async (state: SimulateState) => {
      await api.debugSimulate(state)
      return until(
        () =>
          this.#view?.snapshot.syncthing.state === (state || 'ok')
            ? this.snapshot()
            : false,
        15000,
        `状态 ${state || 'ok'}`,
      )
    },
  }
}

export const appDebug = new AppDebug()
mountDebug('sync', 'app', appDebug)
