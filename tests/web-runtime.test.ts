import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebRuntime } from '../src/debug/web/runtime.ts'
import {
  formatBytes,
  formatSeen,
  folderState,
  connectionKind,
  syncError,
} from '../src/lib/format.ts'
import { initial } from '../src/lib/initial.ts'

test('Web 模拟：快照带示例设备和文件夹，昵称清空回到电脑名', async () => {
  const rt = new WebRuntime(initial)
  const s = rt.state
  assert.equal(s.syncthing.state, 'ok')
  assert.equal(s.syncthing.devices.filter((d) => d.me).length, 1)
  await rt.command('save_identity', { name: '  ' })
  assert.equal(rt.state.identity.name, 'web-mac')
  await rt.command('save_identity', { name: '书房<b>' })
  assert.equal(rt.state.identity.name, '书房b')
})

test('Web 模拟：模拟状态后清空设备和文件夹，启动后恢复', async () => {
  const rt = new WebRuntime(initial)
  const seen: string[] = []
  rt.on('syncthing', (v) => seen.push((v as { state: string }).state))
  await rt.command('debug_simulate', { state: 'stopped' })
  assert.equal(rt.state.syncthing.state, 'stopped')
  assert.equal(rt.state.syncthing.folders.length, 0)
  await rt.command('launch_syncthing', {})
  assert.equal(rt.state.syncthing.state, 'ok')
  assert.deepEqual(seen, ['stopped', 'ok'])
})

test('格式化：字节、最后在线、文件夹状态、连接方式', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(734_003_200), '700 MB')
  const now = Date.parse('2026-11-16T12:00:00Z')
  assert.equal(formatSeen(null, now), '')
  assert.equal(formatSeen('1970-01-01T00:00:00Z', now), '')
  assert.equal(formatSeen('2026-11-16T11:59:40Z', now), '刚刚')
  assert.equal(formatSeen('2026-11-16T11:30:00Z', now), '30 分钟前')
  assert.equal(formatSeen('2026-11-14T12:00:00Z', now), '2 天前')
  assert.equal(folderState('idle', 0).text, '已同步')
  assert.equal(folderState('idle', 10).text, '未完成')
  assert.equal(folderState('sync-preparing', 10).tone, 'busy')
  assert.equal(connectionKind('relay-client', false), '经中转')
  assert.equal(connectionKind('tcp-client', true), '局域网')
  assert.equal(connectionKind('quic-server', false), '直连')
  assert.equal(connectionKind('', false), '')
})

test('Web 模拟：加入待处理文件夹、忽略邀请、接受设备', async () => {
  const rt = new WebRuntime(initial)
  await rt.command('debug_mock', { target: 'folders', state: 'invites' })
  const invite = rt.state.syncthing.pendingFolders[0]
  const id = await rt.command('create_folder', {
    request: {
      id: invite.id,
      label: ' 设计稿 ',
      path: '~/FoxSync/设计稿',
      kind: 'sendreceive',
      devices: invite.offeredBy,
      ignores: '',
      versioning: true,
      autoShare: true,
    },
  })
  assert.equal(id, invite.id)
  const joined = rt.state.syncthing.folders.find((f) => f.id === id)
  assert.equal(joined?.label, '设计稿')
  assert.equal(joined?.path, '/Users/web/FoxSync/设计稿')
  assert.equal(rt.state.syncthing.pendingFolders.length, 2)
  assert.ok(rt.state.autoShare.includes(id))
  // 本机已有、没共享给对方的邀请：共享给它之后邀请就没了
  const mine = rt.state.syncthing.pendingFolders.find((p) => p.existing)
  assert.ok(mine)
  await rt.command('share_folder', {
    device: mine.offeredBy[0],
    folder: mine.id,
    on: true,
  })
  assert.ok(!rt.state.syncthing.pendingFolders.some((p) => p.id === mine.id))
  await assert.rejects(
    rt.command('create_folder', {
      request: {
        id,
        label: 'x',
        path: '/tmp/x',
        kind: 'sendreceive',
        devices: [],
        ignores: '',
        versioning: true,
        autoShare: false,
      },
    }),
  )
  await rt.command('debug_mock', { target: 'devices', state: 'requests' })
  const device = rt.state.syncthing.pendingDevices[0]
  await rt.command('accept_device', { id: device.id })
  assert.ok(rt.state.syncthing.devices.some((d) => d.id === device.id))
  assert.equal(rt.state.syncthing.pendingDevices.length, 0)
})

test('Mock：页面状态从复制的数据上改，恢复回原样；操作只改复制品', async () => {
  const rt = new WebRuntime(initial)
  const real = structuredClone(rt.state)
  real.syncthing.folders[0].label = '真实的文件夹'
  rt.seed(real)
  const f = rt.state.syncthing.folders[0]
  await rt.command('debug_mock', {
    target: 'folder',
    state: 'conflict',
    id: f.id,
  })
  assert.equal(rt.state.syncthing.folders[0].conflicts, 2)
  assert.equal(rt.state.syncthing.folders[0].label, '真实的文件夹')
  const list = (await rt.command('folder_conflicts', { id: f.id })) as {
    path: string
  }[]
  const token = (await rt.command('resolve_conflict', {
    id: f.id,
    path: list[0].path,
    choice: 'drop',
  })) as string
  assert.equal(rt.state.syncthing.folders[0].conflicts, 1)
  // 撤销放回原位置，同一个 token 只能用一次
  await rt.command('undo_conflict', { id: f.id, token })
  assert.deepEqual(
    ((await rt.command('folder_conflicts', { id: f.id })) as typeof list).map(
      (c) => c.path,
    ),
    list.map((c) => c.path),
  )
  await assert.rejects(rt.command('undo_conflict', { id: f.id, token }))
  await rt.command('resolve_conflict', {
    id: f.id,
    path: list[0].path,
    choice: 'drop',
  })
  // 换一个状态不叠加：冲突没了，变成出错
  await rt.command('debug_mock', { target: 'folder', state: 'error', id: f.id })
  assert.deepEqual(
    [
      rt.state.syncthing.folders[0].conflicts,
      rt.state.syncthing.folders[0].state,
    ],
    [0, 'error'],
  )
  const other = rt.state.syncthing.devices[1].id
  await rt.command('debug_mock', { target: 'devices', state: 'stopped' })
  assert.equal(rt.state.syncthing.state, 'stopped')
  await rt.command('debug_mock', {
    target: 'device',
    state: 'never',
    id: other,
  })
  assert.equal(rt.state.syncthing.devices[1].lastSeen, null)
  await rt.command('debug_mock', { target: 'dialog', state: 'ignores' })
  assert.equal(
    (
      (await rt.command('inspect_path', { path: '~/x' })) as {
        hasIgnores: boolean
      }
    ).hasIgnores,
    true,
  )
  await rt.command('debug_reset', {})
  assert.equal(rt.state.syncthing.state, 'ok')
  assert.equal(rt.state.syncthing.folders[0].conflicts, 0)
  assert.equal(rt.state.syncthing.folders[0].label, '真实的文件夹')
})

test('Mock：文件夹和设备操作', async () => {
  const rt = new WebRuntime(initial)
  const f = rt.state.syncthing.folders[0]
  await rt.command('folder_action', { id: f.id, action: 'pause' })
  assert.equal(rt.state.syncthing.folders[0].paused, true)
  await rt.command('update_folder', {
    id: f.id,
    patch: { label: '新名字', kind: 'sendonly', versioning: false },
  })
  assert.deepEqual(
    [
      rt.state.syncthing.folders[0].label,
      rt.state.syncthing.folders[0].kind,
      rt.state.syncthing.folders[0].versioning,
    ],
    ['新名字', 'sendonly', false],
  )
  await rt.command('set_folder_ignores', { id: f.id, text: '*.log' })
  assert.equal(await rt.command('folder_ignores', { id: f.id }), '*.log')
  const peer = rt.state.peers[0].syncthingId
  await assert.rejects(
    rt.command('update_device', { id: peer, patch: { name: 'x' } }),
  )
  await rt.command('remove_device', { id: peer })
  assert.ok(!rt.state.syncthing.devices.some((d) => d.id === peer))
  assert.equal(rt.state.peers[0].settled, true)
  // 移除后在“频道里的其他设备”里能重新添加，自动共享的文件夹也补上它
  await rt.command('add_peer', { id: rt.state.peers[0].id })
  assert.ok(rt.state.syncthing.devices.some((d) => d.id === peer))
  await rt.command('remove_folder', { id: f.id })
  assert.ok(!rt.state.syncthing.folders.some((x) => x.id === f.id))
})

test('格式化：Syncthing 常见出错原因换成中文', () => {
  assert.equal(syncError('open /a/b: permission denied'), '没有权限读写')
  assert.equal(syncError('something new'), 'something new')
})

test('Mock：忽略邀请记进已忽略，恢复后回到可加入', async () => {
  const rt = new WebRuntime(initial)
  await rt.command('debug_mock', { target: 'folders', state: 'invites' })
  const invite = rt.state.syncthing.pendingFolders[0]
  await rt.command('ignore_folder', { id: invite.id })
  assert.ok(!rt.state.syncthing.pendingFolders.some((p) => p.id === invite.id))
  const ignored = rt.state.syncthing.ignoredFolders.find(
    (f) => f.id === invite.id,
  )
  assert.ok(ignored)
  await rt.command('restore_ignored', {
    device: ignored.device,
    id: ignored.id,
  })
  assert.ok(rt.state.syncthing.pendingFolders.some((p) => p.id === invite.id))
  assert.equal(rt.state.syncthing.ignoredFolders.length, 0)
})

test('Mock：忽略设备请求记进已忽略的设备，恢复后移除', async () => {
  const rt = new WebRuntime(initial)
  await rt.command('debug_mock', { target: 'devices', state: 'requests' })
  const req = rt.state.syncthing.pendingDevices[0]
  await rt.command('ignore_device', { id: req.id })
  assert.deepEqual(
    rt.state.syncthing.ignoredDevices.map((d) => d.id),
    [req.id],
  )
  await rt.command('restore_device', { id: req.id })
  assert.equal(rt.state.syncthing.ignoredDevices.length, 0)
})

test('Mock：位置相同或嵌套都算和已有文件夹重叠，新建会被拦', async () => {
  const rt = new WebRuntime(initial)
  const f = rt.state.syncthing.folders[0]
  const overlap = async (path: string) =>
    ((await rt.command('inspect_path', { path })) as { overlap: string })
      .overlap
  assert.equal(await overlap(f.path), f.label)
  assert.equal(await overlap(`${f.path}/sub`), f.label)
  assert.equal(await overlap(f.path.split('/').slice(0, -1).join('/')), f.label)
  assert.equal(await overlap(`${f.path}-2`), '')
  await assert.rejects(
    rt.command('create_folder', {
      request: {
        id: null,
        label: 'x',
        path: `${f.path}/sub`,
        kind: 'sendreceive',
        devices: [],
        ignores: '',
        versioning: true,
        autoShare: false,
      },
    }),
    /重叠/,
  )
})

test('Mock：文件夹详情里每台设备的加入情况', async () => {
  const rt = new WebRuntime(initial)
  const f = rt.state.syncthing.folders[0]
  await rt.command('debug_mock', {
    target: 'folder',
    state: 'waiting',
    id: f.id,
  })
  const members = (await rt.command('folder_members', { id: f.id })) as {
    device: string
    state: string
  }[]
  assert.ok(members.some((m) => m.state === 'notSharing'))
})

test('Web 模拟：大文件分档，加入忽略后从列表里消失', async () => {
  const rt = new WebRuntime(initial)
  const id = rt.state.syncthing.folders[0].id
  type Result = {
    tiers: { min: number; count: number }[]
    files: { path: string }[]
  }
  const before = (await rt.command('large_files', { id })) as Result
  assert.deepEqual(
    before.tiers.map((t) => t.count),
    [42, 6, 4, 1],
  )
  const text = (await rt.command('ignore_file', {
    id,
    path: '工程/贴图 [4k].zip',
  })) as string
  assert.ok(text.endsWith('/工程/贴图 \\[4k\\].zip'))
  // 再加一次不重复
  await rt.command('ignore_file', { id, path: '工程/贴图 [4k].zip' })
  assert.equal(
    ((await rt.command('folder_ignores', { id })) as string).split('\n').length,
    text.split('\n').length,
  )
  const after = (await rt.command('large_files', { id })) as Result
  assert.ok(!after.files.some((f) => f.path === '工程/贴图 [4k].zip'))
  assert.equal(after.tiers[1].count, 5)
  // 撤销只删这一行，别的规则不动
  const undone = (await rt.command('unignore_file', {
    id,
    path: '工程/贴图 [4k].zip',
  })) as string
  assert.equal(undone, text.split('\n').slice(0, -1).join('\n'))
  const back = (await rt.command('large_files', { id })) as Result
  assert.equal(back.tiers[1].count, 6)
})

test('Mock：很多设备共享同一个文件夹', async () => {
  const rt = new WebRuntime(initial)
  const before = rt.state.syncthing.folders[0].devices.length
  await rt.command('debug_mock', { target: 'folders', state: 'crowd' })
  assert.equal(rt.state.syncthing.folders[0].devices.length, before + 10)
  assert.equal(rt.state.syncthing.devices.filter((d) => !d.me).length, 12)
  // 回到原样时多出来的设备和频道成员都撤掉
  const peers = rt.state.peers.length
  await rt.command('debug_mock', { target: 'folders', state: 'normal' })
  assert.equal(rt.state.syncthing.folders[0].devices.length, before)
  assert.ok(rt.state.peers.length < peers)
})
