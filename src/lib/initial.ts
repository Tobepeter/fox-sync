import type { Snapshot } from './bindings/Snapshot'

// 首屏占位，拿到真实快照前使用；字段与 Rust 默认值一致
export const initial: Snapshot = {
  settings: {
    dockMode: 'window',
    theme: 'system',
    avatarStyle: 'lorelei',
    launchAtLogin: false,
    autoAdd: true,
    autoJoin: true,
    joinRoot: '~/FoxSync',
  },
  identity: { id: '', name: '' },
  syncthing: {
    state: 'checking',
    error: '',
    url: '',
    version: '',
    myId: '',
    devices: [],
    folders: [],
    pendingFolders: [],
    pendingDevices: [],
    ignoredFolders: [],
    ignoredDevices: [],
    daemon: { state: 'idle', occupant: null, error: '', tail: [] },
  },
  channel: {
    state: 'connecting',
    error: '',
    topic: '',
    retryAt: null,
    announced: false,
  },
  peers: [],
  autoShare: [],
  computerName: '',
  version: '',
  dev: false,
}
