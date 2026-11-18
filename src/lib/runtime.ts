import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { initial } from './initial'
import type { Snapshot } from './bindings/Snapshot'
import type { Settings } from './bindings/Settings'
import type { Identity } from './bindings/Identity'
import type { Syncthing } from './bindings/Syncthing'
import type { Device } from './bindings/Device'
import type { Folder } from './bindings/Folder'
import type { Occupant } from './bindings/Occupant'
import type { PendingFolder } from './bindings/PendingFolder'
import type { PendingDevice } from './bindings/PendingDevice'
import type { FolderRequest } from './bindings/FolderRequest'
import type { PathInfo } from './bindings/PathInfo'
import type { Channel } from './bindings/Channel'
import type { Peer } from './bindings/Peer'
import type { FolderPatch } from './bindings/FolderPatch'
import type { DevicePatch } from './bindings/DevicePatch'
import type { FileIssue } from './bindings/FileIssue'
import type { IgnoredFolder } from './bindings/IgnoredFolder'
import type { Member } from './bindings/Member'
import type { LargeFiles } from './bindings/LargeFiles'
import type { LargeFile } from './bindings/LargeFile'
export type {
  LargeFiles,
  LargeFile,
  Member,
  IgnoredFolder,
  FolderPatch,
  DevicePatch,
  FileIssue,
  Channel,
  Peer,
  Snapshot,
  Settings,
  Identity,
  Syncthing,
  Device,
  Folder,
  Occupant,
  PendingFolder,
  PendingDevice,
  FolderRequest,
  PathInfo,
}

export const desktop = isTauri()
// 浏览器 DEV 走模拟运行时，正式构建的浏览器页面只读
export const webPreview = import.meta.env.DEV && !desktop
export const available = desktop || webPreview

/** 清除数据时一并清掉本窗口 localStorage 里 FoxSync 自己的键（都以 fox-sync: 开头） */
export function clearLocal() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('fox-sync:'))
      .forEach((k) => localStorage.removeItem(k))
  } catch {}
}

/** DEV：调试页里的 Mock 模式开关，存在 localStorage（只对这个窗口，不进 data.json，清除数据时一并清掉），打开后各页面右下角出现本页的状态浮窗 */
export const MOCK_BAR_KEY = 'fox-sync:mock'
/** DEV：Mock 浮窗切了状态后广播的事件，detail 是 { target, state } */
export const MOCK_EVENT = 'fox-sync:mocked'

// DEV：状态条选了某个状态后，命令和事件改走内存里的模拟数据（从当前真实数据复制一份再改），
// 不碰真实 Syncthing；点“恢复”切回真实数据。浏览器 DEV 一直走模拟数据
// 开关和模拟运行时挂在 window 上整页共用：热更新出了岔子、页面里多出一份本模块时，
// 界面听的和 Mock 浮窗改的仍是同一份（2026-11-18 踩到：浮窗打开了开关，界面那份还关着，点了没反应）
type DevShared = {
  overlay: boolean
  preview?: Promise<import('../debug/web/runtime').WebRuntime>
}
const dev = globalThis as { __foxSyncDev?: DevShared }
const shared: DevShared = import.meta.env.DEV
  ? (dev.__foxSyncDev ??= { overlay: false })
  : { overlay: false }
const mocked = () => webPreview || shared.overlay
export const mockActive = () => import.meta.env.DEV && shared.overlay

/** DEV 调试能模拟的 Syncthing 状态，空串表示恢复真实状态 */
export type SimulateState =
  '' | 'starting' | 'occupied' | 'failed' | 'stopped' | 'error'

// DEV 动态入口在生产构建中整体剔除
async function preview() {
  if (import.meta.env.DEV) {
    return (shared.preview ??= import('../debug/web/runtime').then(
      (module) => new module.WebRuntime(initial),
    ))
  }
  throw new Error('此功能需要桌面端')
}

async function call<T = void>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (desktop && !mocked()) return invoke<T>(command, args)
  if (import.meta.env.DEV)
    return (await preview()).command(command, args) as Promise<T>
  throw new Error('此功能需要桌面端')
}

async function on<T>(
  name: string,
  callback: (value: T) => void,
): Promise<() => void> {
  if (!import.meta.env.DEV)
    return desktop
      ? listen<T>(name, (event) => callback(event.payload))
      : () => {}
  // 开发版两边都听，按当前是否在 Mock 里只放行一边
  const stops: (() => void)[] = [
    await (
      await preview()
    ).on(name, (value) => mocked() && callback(value as T)),
  ]
  if (desktop)
    stops.push(
      await listen<T>(name, (event) => !mocked() && callback(event.payload)),
    )
  return () => stops.forEach((stop) => stop())
}

export const api = {
  snapshot: () => call<Snapshot>('get_snapshot'),
  saveSettings: (settings: Settings) => call('save_settings', { settings }),
  saveIdentity: (name: string) => call('save_identity', { name }),
  resetSettings: () => call('reset_settings'),
  refreshSyncthing: () => call('refresh_syncthing'),
  launchSyncthing: () => call('launch_syncthing'),
  reconnectChannel: () => call('reconnect_channel'),
  syncthingTakeOver: () => call('syncthing_take_over'),
  revealPath: (path: string) => call('reveal_path', { path }),
  createFolder: (request: FolderRequest) =>
    call<string>('create_folder', { request }),
  ignoreFolder: (id: string) => call('ignore_folder', { id }),
  acceptDevice: (id: string) => call('accept_device', { id }),
  ignoreDevice: (id: string) => call('ignore_device', { id }),
  folderAction: (
    id: string,
    action: 'pause' | 'resume' | 'rescan' | 'override' | 'revert',
  ) => call('folder_action', { id, action }),
  updateFolder: (id: string, patch: FolderPatch) =>
    call('update_folder', { id, patch }),
  removeFolder: (id: string) => call('remove_folder', { id }),
  folderIgnores: (id: string) => call<string>('folder_ignores', { id }),
  largeFiles: (id: string) => call<LargeFiles>('large_files', { id }),
  /** 把一个文件加进忽略规则，返回保存后的全文 */
  ignoreFile: (id: string, path: string) =>
    call<string>('ignore_file', { id, path }),
  /** 撤销加入忽略：删掉这个文件那一行，返回保存后的全文 */
  unignoreFile: (id: string, path: string) =>
    call<string>('unignore_file', { id, path }),
  setFolderIgnores: (id: string, text: string) =>
    call('set_folder_ignores', { id, text }),
  folderErrors: (id: string) => call<FileIssue[]>('folder_errors', { id }),
  folderConflicts: (id: string) =>
    call<FileIssue[]>('folder_conflicts', { id }),
  /** 返回撤销用的 token */
  resolveConflict: (id: string, path: string, choice: 'keep' | 'drop') =>
    call<string>('resolve_conflict', { id, path, choice }),
  /** 撤销刚才的冲突处理，文件放回处理前的样子 */
  undoConflict: (id: string, token: string) =>
    call('undo_conflict', { id, token }),
  updateDevice: (id: string, patch: DevicePatch) =>
    call('update_device', { id, patch }),
  removeDevice: (id: string) => call('remove_device', { id }),
  /** 手动添加频道里的设备，id 是对方的 FoxSync ID */
  addPeer: (id: string) => call('add_peer', { id }),
  setOnline: (online: boolean) => call('set_online', { online }),
  folderMembers: (id: string) => call<Member[]>('folder_members', { id }),
  restoreDevice: (id: string) => call('restore_device', { id }),
  restoreIgnored: (device: string, id: string) =>
    call('restore_ignored', { device, id }),
  shareFolder: (device: string, folder: string, on: boolean) =>
    call('share_folder', { device, folder, on }),
  revealFile: (path: string) => call('reveal_file', { path }),
  inspectPath: (path: string) => call<PathInfo>('inspect_path', { path }),
  pickFolder: (start?: string) => call<string | null>('pick_folder', { start }),
  wipeData: () => call('wipe_data'),
  openLogs: () => call('open_logs'),
  logClient: (level: 'warn' | 'error', event: string, detail: unknown) =>
    call('log_client', { level, event, detail }),
  // 以下只在开发版注册，生产构建里整段剔除
  debugSimulate: (state: SimulateState) =>
    import.meta.env.DEV
      ? call('debug_simulate', { state })
      : Promise.reject(new Error('仅开发版可用')),
  /**
   * DEV：把页面切到某个模拟状态。target 是页面（folders、folder、devices、device、settings、dialog），
   * id 是详情页对象。第一次切时先把当前真实数据复制进模拟运行时
   */
  debugMock: async (target: string, state: string, id?: string) => {
    if (!import.meta.env.DEV) throw new Error('仅开发版可用')
    const rt = await preview()
    // overlay 表示“页面上改过状态”；浏览器里本来就是模拟数据，不用复制
    if (!shared.overlay) {
      if (desktop) rt.seed(await invoke<Snapshot>('get_snapshot'))
      shared.overlay = true
    }
    await rt.command('debug_mock', { target, state, id })
    // 有些页面的状态不在快照里（比如新建表单的“目录是什么情况”），广播一下让页面自己刷新
    window.dispatchEvent(
      new CustomEvent(MOCK_EVENT, { detail: { target, state } }),
    )
  },
  /** DEV：恢复原本的界面：桌面切回真实数据，浏览器回到示例数据 */
  debugRestore: async () => {
    if (!import.meta.env.DEV) throw new Error('仅开发版可用')
    shared.overlay = false
    if (webPreview) await (await preview()).command('debug_reset', {})
    window.dispatchEvent(
      new CustomEvent(MOCK_EVENT, { detail: { target: '', state: '' } }),
    )
  },
}

export const events = {
  snapshot: (cb: (s: Snapshot) => void) => on('snapshot', cb),
  syncthing: (cb: (s: Syncthing) => void) => on('syncthing', cb),
  channel: (cb: (c: Channel) => void) => on('channel', cb),
  /** 频道设备共享来的文件夹被自动加入了，参数是文件夹名 */
  joined: (cb: (label: string) => void) => on('joined', cb),
  navigate: (cb: (page: string) => void) => on('navigate', cb),
  error: (cb: (text: string) => void) => on('error', cb),
}

// DEV：运行时模块（含模拟运行时）热更新时整页刷新。只替换模块会留下两份实例，
// 界面听旧的、Mock 改新的，切状态看不到变化（2026-11-17 踩到）。
// 在应用更新之前就刷新：靠更新完的回调刷新的话，中途存了语法错误那次回调不会执行，页面就一直半新半旧（2026-11-18 踩到）
if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const touched = updates.some((u) =>
      /\/src\/(lib|debug\/web)\/runtime\.ts/.test(
        `${u.path} ${u.acceptedPath}`,
      ),
    )
    if (touched) location.reload()
  })
}
