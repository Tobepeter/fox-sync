// DEBUG：模拟运行时，浏览器 DEV 和桌面开发版的 Mock 模式共用；命令名和返回结构与 Rust 一致，数据只在内存里
// 不依赖 import.meta，供 node --test 直接测试
import type { Snapshot } from '../../lib/bindings/Snapshot'
import type { Settings } from '../../lib/bindings/Settings'
import type { Syncthing } from '../../lib/bindings/Syncthing'
import type { Folder } from '../../lib/bindings/Folder'
import type { FolderRequest } from '../../lib/bindings/FolderRequest'
import type { FolderPatch } from '../../lib/bindings/FolderPatch'
import type { DevicePatch } from '../../lib/bindings/DevicePatch'
import type { FileIssue } from '../../lib/bindings/FileIssue'
import { cleanName } from '../../lib/avatar-text.ts'
import { AVATAR_STYLES, HUMAN_STYLES } from '../../lib/avatar-styles.ts'

type Listener = (value: unknown) => void
const randomStyle = () =>
  HUMAN_STYLES[Math.floor(Math.random() * HUMAN_STYLES.length)]
const PRESETS: readonly string[] = AVATAR_STYLES
const COMPUTER = 'web-mac'
const HOME = '/Users/web'
const ME = 'WEBME01-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG'
const M5 = 'WEBM5AA-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG'
const M3 = 'WEBM3AA-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG'
const MINI = 'WEBNEW1-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG'

/** 每个页面能切的模拟状态；Syncthing 的几种异常状态挂在文件夹和设备列表上（那里会出整页提示） */
const GATE = [
  { id: 'starting', label: '启动中' },
  { id: 'occupied', label: '被占用' },
  { id: 'failed', label: '起不来' },
  { id: 'stopped', label: '连不上' },
]
export const MOCK_STATES: Record<string, { id: string; label: string }[]> = {
  folders: [
    { id: 'syncing', label: '同步中' },
    { id: 'conflict', label: '有冲突' },
    { id: 'error', label: '出错' },
    { id: 'paused', label: '全部暂停' },
    { id: 'invites', label: '有邀请' },
    { id: 'crowd', label: '很多设备' },
    { id: 'ignored', label: '有已忽略的邀请' },
    { id: 'empty', label: '空列表' },
    ...GATE,
  ],
  folder: [
    { id: 'idle', label: '已同步' },
    { id: 'syncing', label: '同步中' },
    { id: 'scanning', label: '扫描中' },
    { id: 'conflict', label: '有冲突' },
    { id: 'error', label: '出错' },
    { id: 'sendonly', label: '仅发送有差异' },
    { id: 'receiveonly', label: '仅接收有改动' },
    { id: 'paused', label: '已暂停' },
    { id: 'waiting', label: '有设备等待加入' },
  ],
  devices: [
    { id: 'offline', label: '都离线' },
    { id: 'me-offline', label: '本机离线' },
    { id: 'requests', label: '有请求' },
    { id: 'ignored', label: '有已忽略的设备' },
    { id: 'others', label: '频道里有未添加的' },
    { id: 'alone', label: '只有本机' },
    { id: 'channel-down', label: '频道断开' },
    ...GATE,
  ],
  device: [
    { id: 'lan', label: '局域网' },
    { id: 'direct', label: '直连' },
    { id: 'relay', label: '经中转' },
    { id: 'offline', label: '离线' },
    { id: 'never', label: '没连上过' },
    { id: 'paused', label: '已暂停' },
  ],
  settings: [
    { id: 'connecting', label: '频道连接中' },
    { id: 'waiting', label: '频道断开' },
    { id: 'unconfigured', label: '没内置频道' },
  ],
  dialog: [
    { id: 'missing', label: '目录不存在' },
    { id: 'empty', label: '空目录' },
    { id: 'full', label: '目录不空' },
    { id: 'ignores', label: '已有 .stignore' },
    { id: 'overlap', label: '和已有文件夹重叠' },
  ],
}

function randomId(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(
    bytes,
    (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36],
  ).join('')
}

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString()

function folder(
  id: string,
  label: string,
  path: string,
  devices: string[],
  extra: Partial<Folder> = {},
): Folder {
  return {
    id,
    label,
    path,
    kind: 'sendreceive',
    paused: false,
    state: 'idle',
    error: '',
    devices,
    globalBytes: 52_428_800,
    globalItems: 320,
    localBytes: 52_428_800,
    needBytes: 0,
    needItems: 0,
    errorItems: 0,
    localChanges: 0,
    versioning: true,
    conflicts: 0,
    ...extra,
  }
}

// 示例数据：两台别的机器，一台在线经中转、一台离线；三个文件夹覆盖已同步、同步中、仅发送
export function sampleSyncthing(): Syncthing {
  return {
    state: 'ok',
    error: '',
    url: 'http://127.0.0.1:8384',
    version: 'v2.1.6',
    myId: ME,
    daemon: { state: 'running', occupant: null, error: '', tail: [] },
    devices: [
      {
        id: ME,
        name: COMPUTER,
        me: true,
        connected: false,
        paused: false,
        kind: '',
        address: '',
        local: false,
        clientVersion: '',
        lastSeen: null,
      },
      {
        id: M5,
        name: 'eating-m5',
        me: false,
        connected: true,
        paused: false,
        kind: 'relay-client',
        address: '203.0.113.9:22067',
        local: false,
        clientVersion: 'v2.1.6',
        lastSeen: ago(0),
      },
      {
        id: M3,
        name: 'eating-m3',
        me: false,
        connected: false,
        paused: false,
        kind: '',
        address: '',
        local: false,
        clientVersion: '',
        lastSeen: ago(60 * 26),
      },
    ],
    folders: [
      folder('k3n9q-x7w2p', '接力资料', `${HOME}/Desktop/work/handoff`, [M5]),
      folder('p2m7d-a9c4e', '照片备份', `${HOME}/Pictures/备份`, [M5, M3], {
        globalBytes: 3_221_225_472,
        localBytes: 2_487_222_272,
        globalItems: 5120,
      }),
      folder(
        'ai-test-network-probe-20261017',
        '网络测试',
        `${HOME}/playground/syncthing-network-test`,
        [],
        {
          kind: 'sendonly',
          versioning: false,
          globalBytes: 2_097_318,
          globalItems: 12,
        },
      ),
    ],
    pendingFolders: [],
    pendingDevices: [],
    ignoredFolders: [],
    ignoredDevices: [],
  }
}

type Extras = {
  /** 文件夹 ID → 还没加入的设备 */
  waiting: Record<string, string[]>
  conflicts: Record<string, FileIssue[]>
  errors: Record<string, FileIssue[]>
  ignores: Record<string, string>
}

const IGNORES =
  '// FoxSync 生成的忽略规则，只对这台机器生效\n\n// 系统文件\n(?d).DS_Store\n(?d)._*\n\n// 依赖目录\n// node_modules\n'

export class WebRuntime {
  state: Snapshot
  #listeners = new Map<string, Set<Listener>>()
  #initial: Snapshot
  #simulate = ''
  /** 不模拟 Syncthing 状态时显示的数据，所有操作都改它 */
  #base: Syncthing
  #extras: Extras = { waiting: {}, conflicts: {}, errors: {}, ignores: {} }
  /** 冲突处理的撤销：token → 处理前的冲突列表 */
  #undo = new Map<string, { id: string; list: FileIssue[] }>()
  /** 复制进来时的样子，切状态前先回到它，状态之间不叠加 */
  #original: Snapshot
  /** 对话框里“目录是什么情况”的模拟，空表示按路径猜 */
  #inspect = ''

  constructor(initial: Snapshot) {
    this.#initial = initial
    this.#base = sampleSyncthing()
    this.state = this.#fresh()
    this.#original = structuredClone(this.state)
    this.#restore()
  }

  /** 把真实快照复制进来，之后的模拟都在复制品上改 */
  seed(snapshot: Snapshot) {
    this.#original = structuredClone(snapshot)
    this.#restore()
  }

  #restore() {
    this.state = structuredClone(this.#original)
    this.#base = this.state.syncthing
    this.#simulate = ''
    this.#inspect = ''
    this.#extras = {
      waiting: {},
      conflicts: {},
      errors: {},
      ignores: Object.fromEntries(
        this.#base.folders.map((f) => [f.id, IGNORES]),
      ),
    }
    this.#emit('snapshot', this.state)
  }

  #fresh(): Snapshot {
    return {
      ...this.#initial,
      settings: { ...this.#initial.settings, avatarStyle: randomStyle() },
      identity: { id: randomId(12), name: COMPUTER },
      syncthing: this.#base,
      channel: {
        state: 'connected',
        error: '',
        topic: 'notify-sync',
        retryAt: null,
        announced: true,
      },
      // eating-m5 是经频道配对的，用它自己的 FoxSync 头像；eating-m3 是手动配对的
      peers: [
        {
          id: 'webm5fox0001',
          name: 'eating-m5',
          avatar: 'notionists',
          syncthingId: M5,
          seen: Math.floor(Date.now() / 1000) - 60,
          settled: true,
        },
      ],
      autoShare: ['k3n9q-x7w2p'],
      computerName: COMPUTER,
      version: '0.1.0',
      dev: true,
    }
  }

  /** 某个页面切到某个状态：先回到复制进来时的样子，再改出这个状态 */
  #mock(target: string, state: string, id?: string) {
    this.#restore()
    const s = this.#base
    const others = s.devices.filter((d) => !d.me)
    const short = (others[0]?.id ?? 'ABCDEFG').slice(0, 7)
    const conflict = (f: Folder) => {
      f.conflicts = 2
      this.#extras.conflicts[f.id] = [
        {
          path: `方案.sync-conflict-20261116-101500-${short}.md`,
          detail: '方案.md',
          time: Date.now() / 1000 - 3600,
        },
        {
          path: `素材/封面.sync-conflict-20261117-083000-${short}.png`,
          detail: '素材/封面.png',
          time: Date.now() / 1000 - 600,
        },
      ]
    }
    const error = (f: Folder) => {
      Object.assign(f, {
        state: 'error',
        error: 'folder path missing',
        errorItems: 2,
      })
      this.#extras.errors[f.id] = [
        {
          path: '2026/IMG_0012.HEIC',
          detail: 'open: permission denied',
          time: 0,
        },
        {
          path: '旧相册/封面.jpg',
          detail: 'file modified but not rescanned; will try again later',
          time: 0,
        },
      ]
    }
    const folderState = (f: Folder, st: string) => {
      switch (st) {
        case 'syncing':
          Object.assign(f, {
            state: 'syncing',
            needBytes: Math.max(Math.round(f.globalBytes * 0.35), 1_048_576),
            needItems: 42,
          })
          break
        case 'scanning':
          f.state = 'scanning'
          break
        case 'conflict':
          conflict(f)
          break
        case 'error':
          error(f)
          break
        case 'sendonly':
          Object.assign(f, { kind: 'sendonly', needItems: 3, needBytes: 4096 })
          break
        case 'receiveonly':
          Object.assign(f, { kind: 'receiveonly', localChanges: 5 })
          break
        case 'waiting': {
          const d = others.find((x) => !x.paused)
          if (d) {
            if (!f.devices.includes(d.id)) f.devices.push(d.id)
            this.#extras.waiting[f.id] = [d.id]
          }
          break
        }
        case 'paused':
          Object.assign(f, { paused: true, state: 'paused' })
          break
        default:
          Object.assign(f, {
            state: 'idle',
            paused: false,
            needBytes: 0,
            needItems: 0,
            error: '',
            errorItems: 0,
            conflicts: 0,
            localChanges: 0,
          })
      }
    }
    if (
      GATE.some((g) => g.id === state) &&
      (target === 'folders' || target === 'devices')
    ) {
      this.#simulate = state
    } else if (target === 'folders') {
      if (state === 'syncing')
        s.folders.slice(0, 2).forEach((f) => folderState(f, 'syncing'))
      if (state === 'conflict' && s.folders[0]) conflict(s.folders[0])
      if (state === 'error' && s.folders[0]) error(s.folders[0])
      if (state === 'paused') s.folders.forEach((f) => folderState(f, 'paused'))
      if (state === 'empty') s.folders = []
      // 很多设备共享同一个文件夹：看头像叠起来的样子（超过 4 个折成“+N”）
      if (state === 'crowd') {
        const names = [
          '设计部 iMac',
          '前台',
          '会议室',
          'tobe-mini',
          '小王的 MBP',
          '渲染机',
          'NAS',
          '老李',
          '实习生',
          '备用机',
        ]
        const styles = [
          'notionists',
          'adventurer',
          'lorelei',
          'micah',
          'thumbs',
        ]
        const crowd = names.map((name, i) => {
          const id = `WEBCR${String(i).padStart(2, '0')}-AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG`
          return {
            id,
            name,
            me: false,
            connected: i % 3 !== 2,
            paused: false,
            kind: i % 3 !== 2 ? 'tcp-client' : '',
            address: i % 3 !== 2 ? `192.168.1.${30 + i}:22000` : '',
            local: i % 3 !== 2,
            clientVersion: 'v2.1.6',
            lastSeen: ago(i % 3 !== 2 ? 0 : 60 * 24),
          }
        })
        s.devices.push(...crowd)
        // 一半来自频道，带各自的头像风格
        this.state.peers = [
          ...this.state.peers,
          ...crowd.slice(0, 6).map((d, i) => ({
            id: `webcrowd${i}`,
            name: d.name,
            avatar: styles[i % styles.length],
            syncthingId: d.id,
            seen: Math.floor(Date.now() / 1000) - 60,
            settled: true,
          })),
        ]
        const ids = crowd.map((d) => d.id)
        if (s.folders[0]) s.folders[0].devices.push(...ids)
        if (s.folders[1]) s.folders[1].devices.push(...ids.slice(0, 3))
      }
      if (state === 'ignored') {
        const from = others[0]?.id ?? MINI
        s.ignoredFolders = [
          {
            id: 'z9x8c-v7b6n',
            label: '旧项目归档',
            device: from,
            time: ago(60 * 24 * 3),
          },
          {
            id: 'm1n2b-v3c4x',
            label: '临时文件',
            device: from,
            time: ago(60 * 5),
          },
        ]
      }
      if (state === 'invites') {
        const from = others.map((d) => d.id)
        s.pendingFolders = [
          {
            id: 'w8r2k-m4t6z',
            label: '设计稿',
            offeredBy: from.slice(0, 1),
            time: ago(12),
            existing: false,
          },
          {
            id: 'q1v8n-s3j5d',
            label: '读书笔记',
            offeredBy: from,
            time: ago(60 * 5),
            existing: false,
          },
        ]
        // 本机已有、没共享给对方的：按钮是“共享”
        const mine = s.folders.find((f) =>
          from.some((d) => !f.devices.includes(d)),
        )
        if (mine)
          s.pendingFolders.push({
            id: mine.id,
            label: mine.label,
            offeredBy: from
              .filter((d) => !mine.devices.includes(d))
              .slice(0, 1),
            time: ago(60 * 30),
            existing: true,
          })
      }
    } else if (target === 'folder') {
      const f = s.folders.find((x) => x.id === id)
      if (f) folderState(f, state)
    } else if (target === 'devices') {
      if (state === 'offline')
        others.forEach((d) =>
          Object.assign(d, {
            connected: false,
            kind: '',
            address: '',
            lastSeen: ago(90),
          }),
        )
      if (state === 'me-offline')
        others.forEach((d) =>
          Object.assign(d, {
            paused: true,
            connected: false,
            kind: '',
            address: '',
          }),
        )
      if (state === 'requests')
        s.pendingDevices = [
          {
            id: MINI,
            name: 'tobe-mini',
            address: '192.168.1.23:22000',
            time: ago(3),
          },
        ]
      if (state === 'ignored')
        s.ignoredDevices = [
          {
            id: MINI,
            name: 'tobe-mini',
            address: '192.168.1.23:22000',
            time: ago(60 * 26),
          },
        ]
      // 关了自动添加后新发现的，或者移除过的：在“频道里的其他设备”里手动添加
      if (state === 'others')
        this.state.peers = [
          ...this.state.peers,
          {
            id: 'webminifox01',
            name: 'tobe-mini',
            avatar: 'thumbs',
            syncthingId: MINI,
            seen: Math.floor(Date.now() / 1000) - 600,
            settled: false,
          },
        ]
      if (state === 'alone') s.devices = s.devices.filter((d) => d.me)
      if (state === 'channel-down')
        this.state.channel = {
          ...this.state.channel,
          state: 'waiting',
          error: '连不上服务器',
          retryAt: Date.now() + 30000,
        }
    } else if (target === 'device') {
      const d = s.devices.find((x) => x.id === id)
      const online = (kind: string, address: string, local = false) =>
        Object.assign(d!, {
          connected: true,
          paused: false,
          kind,
          address,
          local,
          clientVersion: 'v2.1.6',
          lastSeen: ago(0),
        })
      if (d) {
        if (state === 'lan') online('tcp-client', '192.168.1.20:22000', true)
        if (state === 'direct') online('quic-client', '203.0.113.5:22000')
        if (state === 'relay') online('relay-client', '203.0.113.9:22067')
        if (state === 'offline')
          Object.assign(d, {
            connected: false,
            paused: false,
            kind: '',
            address: '',
            lastSeen: ago(60 * 3),
          })
        if (state === 'never')
          Object.assign(d, {
            connected: false,
            paused: false,
            kind: '',
            address: '',
            clientVersion: '',
            lastSeen: null,
          })
        if (state === 'paused')
          Object.assign(d, {
            connected: false,
            paused: true,
            kind: '',
            address: '',
          })
      }
    } else if (target === 'settings') {
      this.state.channel = {
        ...this.state.channel,
        state,
        error: state === 'waiting' ? '连不上服务器' : '',
      }
    } else if (target === 'dialog') {
      this.#inspect = state
    }
    this.#syncthing()
    this.#emit('snapshot', this.state)
  }

  on(name: string, listener: Listener) {
    let set = this.#listeners.get(name)
    if (!set) this.#listeners.set(name, (set = new Set()))
    set.add(listener)
    return () => void set.delete(listener)
  }

  #emit(name: string, value: unknown) {
    this.#listeners.get(name)?.forEach((l) => l(structuredClone(value)))
  }

  #syncthing() {
    const s = this.#simulate
    this.state.syncthing = s
      ? {
          ...this.#base,
          state: s,
          error: s === 'error' ? '模拟错误' : '',
          devices: [],
          folders: [],
          pendingFolders: [],
          pendingDevices: [],
          daemon: {
            state: s,
            occupant:
              s === 'occupied'
                ? {
                    kind: 'app',
                    pid: 1,
                    path: '/Applications/Syncthing.app/Contents/Resources/syncthing/syncthing',
                  }
                : null,
            error: s === 'failed' ? '内置 Syncthing 反复退出（退出码 1）' : '',
            tail: s === 'failed' ? ['模拟输出：Failed to acquire lock'] : [],
          },
        }
      : this.#base
    this.#emit('syncthing', this.state.syncthing)
  }

  /** 和 Rust 一样：位置相同或互相包含都算重叠，按路径分段比较 */
  #overlap(path: string) {
    const inside = (a: string, b: string) =>
      a === b || a.startsWith(b.replace(/\/+$/, '') + '/')
    return this.#base.folders.find(
      (f) => inside(path, f.path) || inside(f.path, path),
    )
  }

  #folder(id: unknown) {
    const f = this.#base.folders.find((x) => x.id === id)
    if (!f) throw new Error('找不到这个文件夹')
    return f
  }

  #device(id: unknown) {
    const d = this.#base.devices.find((x) => x.id === id)
    if (!d) throw new Error('找不到这个设备')
    return d
  }

  /** 用户自己加过、接受过、移除过的频道设备，自动添加不再管它 */
  #settle(syncthingId: string) {
    this.state.peers = this.state.peers.map((p) =>
      p.syncthingId === syncthingId ? { ...p, settled: true } : p,
    )
  }

  // 自动共享的文件夹：已配对的频道设备一直在共享列表里
  #autoShare(f: Folder) {
    if (!this.state.autoShare.includes(f.id)) return
    for (const p of this.state.peers) {
      if (
        this.#base.devices.some((d) => d.id === p.syncthingId) &&
        !f.devices.includes(p.syncthingId)
      )
        f.devices.push(p.syncthingId)
    }
  }

  async command(
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (command) {
      case 'get_snapshot':
        return structuredClone(this.state)
      case 'save_settings': {
        const settings = args.settings as Settings
        if (
          settings.avatarStyle !== 'name' &&
          !PRESETS.includes(settings.avatarStyle)
        )
          throw new Error('未知的头像风格')
        if (settings.launchAtLogin)
          throw new Error('开发版不注册登录启动，请在安装版里开启')
        this.state.settings = { ...settings }
        return
      }
      case 'save_identity': {
        const name = cleanName(String(args.name ?? '')) || COMPUTER
        this.state.identity = { ...this.state.identity, name }
        return
      }
      case 'reset_settings':
        this.state.settings = {
          ...this.#initial.settings,
          avatarStyle: this.state.settings.avatarStyle,
        }
        return
      case 'wipe_data':
        this.state = this.#fresh()
        this.#original = structuredClone(this.state)
        this.#restore()
        return
      case 'debug_simulate':
        this.#simulate = String(args.state ?? '')
        this.#syncthing()
        return
      case 'debug_mock':
        this.#mock(
          String(args.target ?? ''),
          String(args.state ?? ''),
          args.id ? String(args.id) : undefined,
        )
        return
      case 'debug_reset':
        this.#restore()
        this.#syncthing()
        return
      case 'refresh_syncthing':
        this.#syncthing()
        return
      case 'reconnect_channel':
        if (this.state.channel.state === 'waiting') {
          this.state.channel = {
            ...this.state.channel,
            state: 'connected',
            error: '',
            retryAt: null,
          }
          this.#emit('channel', this.state.channel)
        }
        return
      case 'launch_syncthing':
      case 'syncthing_take_over':
        this.#simulate = ''
        this.#syncthing()
        return
      case 'create_folder': {
        const r = args.request as FolderRequest
        const label = r.label.trim()
        if (!label) throw new Error('名称不能为空')
        if (!r.path.trim()) throw new Error('请选择一个本地目录')
        const path = r.path.trim().replace(/^~(?=\/|$)/, HOME)
        const id = r.id ?? `${randomId(5)}-${randomId(5)}`
        const overlap = this.#overlap(path)
        if (overlap)
          throw new Error(
            `这个位置和已有的文件夹「${overlap.label || overlap.id}」重叠`,
          )
        if (this.#base.folders.some((f) => f.id === id))
          throw new Error('已经加入过这个文件夹')
        const pending = this.#base.pendingFolders.find((p) => p.id === id)
        const f = folder(
          id,
          label,
          path,
          [...new Set([...(pending?.offeredBy ?? []), ...r.devices])],
          {
            kind: r.kind,
            versioning: r.versioning,
            globalBytes: 0,
            localBytes: 0,
            globalItems: 0,
          },
        )
        this.#base.folders.push(f)
        this.#extras.ignores[id] = r.ignores
        if (r.autoShare) this.state.autoShare.push(id)
        this.#autoShare(f)
        this.#base.pendingFolders = this.#base.pendingFolders.filter(
          (p) => p.id !== id,
        )
        this.#syncthing()
        this.#emit('snapshot', this.state)
        return id
      }
      case 'ignore_folder': {
        const p = this.#base.pendingFolders.find((x) => x.id === args.id)
        if (!p) throw new Error('这个邀请已经不在了')
        this.#base.ignoredFolders.push(
          ...p.offeredBy.map((device) => ({
            id: p.id,
            label: p.label,
            device,
            time: new Date().toISOString(),
          })),
        )
        this.#base.pendingFolders = this.#base.pendingFolders.filter(
          (x) => x.id !== p.id,
        )
        this.#syncthing()
        return
      }
      case 'restore_ignored': {
        const i = this.#base.ignoredFolders.find(
          (x) => x.id === args.id && x.device === args.device,
        )
        if (!i) throw new Error('找不到这条忽略记录')
        this.#base.ignoredFolders = this.#base.ignoredFolders.filter(
          (x) => x !== i,
        )
        // 真实情况下对方重连后邀请回来，这里直接放回“可加入”
        if (!this.#base.pendingFolders.some((x) => x.id === i.id))
          this.#base.pendingFolders.push({
            id: i.id,
            label: i.label,
            offeredBy: [i.device],
            time: new Date().toISOString(),
            existing: false,
          })
        this.#syncthing()
        return
      }
      case 'accept_device': {
        const d = this.#base.pendingDevices.find((x) => x.id === args.id)
        if (!d) throw new Error('这个请求已经不在了')
        this.#base.devices.push({
          id: d.id,
          name: d.name,
          me: false,
          connected: true,
          paused: false,
          kind: 'tcp-client',
          address: d.address,
          local: false,
          clientVersion: 'v2.1.6',
          lastSeen: new Date().toISOString(),
        })
        this.#base.pendingDevices = this.#base.pendingDevices.filter(
          (x) => x.id !== d.id,
        )
        this.#settle(d.id)
        this.#syncthing()
        return
      }
      case 'ignore_device': {
        const d = this.#base.pendingDevices.find((x) => x.id === args.id)
        if (d)
          this.#base.ignoredDevices.push({
            ...d,
            time: new Date().toISOString(),
          })
        this.#base.pendingDevices = this.#base.pendingDevices.filter(
          (x) => x.id !== args.id,
        )
        this.#syncthing()
        return
      }
      case 'restore_device':
        this.#base.ignoredDevices = this.#base.ignoredDevices.filter(
          (x) => x.id !== args.id,
        )
        this.#syncthing()
        return
      case 'folder_action': {
        const f = this.#folder(args.id)
        switch (args.action) {
          case 'pause':
            Object.assign(f, { paused: true, state: 'paused' })
            break
          case 'resume':
            Object.assign(f, { paused: false, state: 'idle' })
            break
          case 'rescan':
            f.state = 'scanning'
            setTimeout(() => {
              if (f.state === 'scanning') f.state = 'idle'
              this.#syncthing()
            }, 1200)
            break
          case 'override':
            Object.assign(f, { needItems: 0, needBytes: 0 })
            break
          case 'revert':
            f.localChanges = 0
            break
          default:
            throw new Error('未知的操作')
        }
        this.#syncthing()
        return
      }
      case 'update_folder': {
        const f = this.#folder(args.id)
        const p = args.patch as FolderPatch
        if (p.label !== undefined) {
          if (!p.label.trim()) throw new Error('名称不能为空')
          f.label = p.label.trim()
        }
        if (p.kind !== undefined) f.kind = p.kind
        if (p.versioning !== undefined) f.versioning = p.versioning
        if (p.devices !== undefined)
          f.devices = p.devices.filter((d) => d !== ME)
        if (p.autoShare !== undefined) {
          this.state.autoShare = this.state.autoShare.filter((x) => x !== f.id)
          if (p.autoShare) this.state.autoShare.push(f.id)
        }
        this.#autoShare(f)
        this.#syncthing()
        this.#emit('snapshot', this.state)
        return
      }
      case 'remove_folder':
        this.#folder(args.id)
        this.#base.folders = this.#base.folders.filter((f) => f.id !== args.id)
        this.state.autoShare = this.state.autoShare.filter((x) => x !== args.id)
        this.#syncthing()
        this.#emit('snapshot', this.state)
        return
      case 'folder_members': {
        const f = this.#folder(args.id)
        return f.devices.map((id) => {
          const d = this.#base.devices.find((x) => x.id === id)
          if (this.#extras.waiting[f.id]?.includes(id))
            return { device: id, state: 'notSharing', completion: 0 }
          if (!d?.connected)
            return {
              device: id,
              state: d?.paused ? 'paused' : 'unknown',
              completion: 0,
            }
          const done = f.globalBytes
            ? 100 - (f.needBytes / f.globalBytes) * 100
            : 100
          return {
            device: id,
            state: 'valid',
            completion: Math.max(0, Math.min(100, done)),
          }
        })
      }
      case 'folder_ignores':
        this.#folder(args.id)
        return this.#extras.ignores[String(args.id)] ?? ''
      case 'set_folder_ignores':
        this.#folder(args.id)
        this.#extras.ignores[String(args.id)] = String(args.text ?? '')
        return
      case 'large_files': {
        this.#folder(args.id)
        const ignored = literalIgnores(
          this.#extras.ignores[String(args.id)] ?? '',
        )
        const files = LARGE_SAMPLE.filter(
          (x) =>
            !ignored.some(
              (p) =>
                x.path.toLowerCase() === p ||
                x.path.toLowerCase().startsWith(`${p}/`),
            ),
        )
        return {
          tiers: LARGE_TIERS.map((min) => {
            const hit = files.filter((x) => x.size >= min)
            return {
              min,
              count: hit.length,
              bytes: hit.reduce((n, x) => n + x.size, 0),
            }
          }),
          files: structuredClone(files),
        }
      }
      case 'ignore_file': {
        this.#folder(args.id)
        const id = String(args.id)
        const line = ignoreLine(String(args.path))
        const text = this.#extras.ignores[id] ?? ''
        if (!text.split('\n').some((l) => l.trim() === line))
          this.#extras.ignores[id] = text.trim()
            ? `${text.trimEnd()}\n${line}`
            : line
        return this.#extras.ignores[id]
      }
      case 'unignore_file': {
        this.#folder(args.id)
        const id = String(args.id)
        const line = ignoreLine(String(args.path))
        this.#extras.ignores[id] = (this.#extras.ignores[id] ?? '')
          .split('\n')
          .filter((l) => l.trim() !== line)
          .join('\n')
        return this.#extras.ignores[id]
      }
      case 'folder_errors':
        this.#folder(args.id)
        return structuredClone(this.#extras.errors[String(args.id)] ?? [])
      case 'folder_conflicts':
        this.#folder(args.id)
        return structuredClone(this.#extras.conflicts[String(args.id)] ?? [])
      case 'resolve_conflict': {
        const f = this.#folder(args.id)
        const all = this.#extras.conflicts[f.id] ?? []
        const list = all.filter((c) => c.path !== args.path)
        const token = `undo-${Date.now()}`
        // 撤销时按原来的位置放回
        this.#undo.set(token, { id: f.id, list: structuredClone(all) })
        this.#extras.conflicts[f.id] = list
        f.conflicts = list.length
        this.#syncthing()
        return token
      }
      case 'undo_conflict': {
        const saved = this.#undo.get(String(args.token))
        if (!saved) throw new Error('已经过了撤销时间')
        this.#undo.delete(String(args.token))
        const f = this.#folder(saved.id)
        this.#extras.conflicts[f.id] = saved.list
        f.conflicts = saved.list.length
        this.#syncthing()
        return
      }
      case 'update_device': {
        const d = this.#device(args.id)
        const p = args.patch as DevicePatch
        if (p.name !== undefined) {
          if (this.state.peers.some((x) => x.syncthingId === d.id))
            throw new Error('经频道配对的设备名字跟着对方的昵称')
          d.name = p.name.trim()
        }
        if (p.paused !== undefined)
          Object.assign(d, {
            paused: p.paused,
            connected: p.paused ? false : d.connected,
          })
        this.#syncthing()
        return
      }
      case 'remove_device': {
        this.#device(args.id)
        this.#base.devices = this.#base.devices.filter((d) => d.id !== args.id)
        this.#base.folders.forEach(
          (f) => (f.devices = f.devices.filter((x) => x !== args.id)),
        )
        this.#settle(String(args.id))
        this.#syncthing()
        this.#emit('snapshot', this.state)
        return
      }
      case 'add_peer': {
        const p = this.state.peers.find((x) => x.id === args.id)
        if (!p) throw new Error('频道里没有这台设备')
        if (!this.#base.devices.some((d) => d.id === p.syncthingId))
          this.#base.devices.push({
            id: p.syncthingId,
            name: p.name,
            me: false,
            connected: true,
            paused: false,
            kind: 'tcp-client',
            address: '192.168.1.23:22000',
            local: true,
            clientVersion: 'v2.1.6',
            lastSeen: new Date().toISOString(),
          })
        this.#settle(p.syncthingId)
        this.#base.folders.forEach((f) => this.#autoShare(f))
        this.#syncthing()
        this.#emit('snapshot', this.state)
        return
      }
      case 'set_online':
        this.#base.devices
          .filter((d) => !d.me)
          .forEach((d) =>
            Object.assign(
              d,
              args.online
                ? { paused: false }
                : { paused: true, connected: false, kind: '', address: '' },
            ),
          )
        this.#syncthing()
        return
      case 'share_folder': {
        const f = this.#folder(args.folder)
        f.devices = f.devices.filter((x) => x !== args.device)
        if (args.on) {
          f.devices.push(String(args.device))
          // 和 Syncthing 一样：共享给对方后，它对这个文件夹的邀请就没了
          this.#base.pendingFolders = this.#base.pendingFolders
            .map((p) =>
              p.id === f.id
                ? {
                    ...p,
                    offeredBy: p.offeredBy.filter((d) => d !== args.device),
                  }
                : p,
            )
            .filter((p) => p.offeredBy.length > 0)
        }
        this.#syncthing()
        return
      }
      case 'inspect_path': {
        const path = String(args.path ?? '')
          .trim()
          .replace(/^~(?=\/|$)/, HOME)
        const overlap = path ? (this.#overlap(path)?.label ?? '') : ''
        const known = this.#base.folders.some((f) => f.path === path)
        const info = (
          exists: boolean,
          entries: number,
          hasIgnores = false,
        ) => ({
          path,
          exists,
          isDir: exists,
          entries,
          hasIgnores,
          overlap,
        })
        switch (this.#inspect) {
          case 'missing':
            return info(false, 0)
          case 'empty':
            return info(true, 0)
          case 'full':
            return info(true, 12)
          case 'ignores':
            return info(true, 12, true)
          case 'overlap':
            return {
              ...info(true, 12),
              overlap: this.#base.folders[0]?.label || '接力资料',
            }
        }
        return info(known, known ? 12 : 0)
      }
      case 'pick_folder':
        return `${HOME}/Documents/资料`
      case 'reveal_path':
      case 'reveal_file':
      case 'open_logs':
      case 'log_client':
        return
      default:
        throw new Error(`模拟运行时没有实现 ${command}`)
    }
  }
}

// 大文件：每个文件夹给同一份示例，覆盖四个档位，1 MB 档够多、能翻页；规则和 Rust 的 large.rs 一致
const MB = 1 << 20
const LARGE_TIERS = [MB, 10 * MB, 100 * MB, 1024 * MB]
const LARGE_SAMPLE = [
  { path: '素材/发布会 原片.mov', size: 2.4 * 1024 * MB },
  { path: '素材/采访-B 机位.mp4', size: 860 * MB },
  { path: '导出/预告片 v3.mp4', size: 312 * MB },
  { path: '工程/场景.blend', size: 148 * MB },
  { path: '工程/贴图 [4k].zip', size: 64 * MB },
  { path: '参考/资料合集.pdf', size: 23 * MB },
  ...Array.from({ length: 36 }, (_, i) => ({
    path: `照片/2026-10/IMG_${String(4100 + i).padStart(4, '0')}.heic`,
    size: Math.round((1.2 + ((i * 7) % 9) * 0.9) * MB),
  })),
].sort((a, b) => b.size - a.size)

function ignoreLine(path: string) {
  return `/${path.replace(/[\\*?[\]{}]/g, (c) => `\\${c}`)}`
}

function literalIgnores(text: string) {
  return text.split('\n').flatMap((raw) => {
    let line = raw.trim()
    while (/^\(\?[di]\)/.test(line)) line = line.slice(4)
    if (!line.startsWith('/') || line.startsWith('//')) return []
    let out = ''
    for (let i = 1; i < line.length; i++) {
      const c = line[i]
      if (c === '\\') out += line[++i] ?? ''
      else if ('*?[]{}'.includes(c)) return []
      else out += c
    }
    out = out.replace(/\/+$/, '').toLowerCase()
    return out ? [out] : []
  })
}
