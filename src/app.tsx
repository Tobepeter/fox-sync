import { useLocation } from 'wouter'
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import {
  Bug,
  FolderPlus,
  FolderSync,
  MonitorSmartphone,
  RotateCw,
  Settings as SettingsIcon,
} from 'lucide-react'
import { Toaster } from './components/ui/sonner'
import { offerUndo } from './lib/undo'
import { Sheet, SheetContent } from './components/ui/sheet'
import { Button } from './components/ui/button'
import { Devices } from './components/devices'
import { Folders } from './components/folders'
import { IgnoredDevices, IgnoredFolders } from './components/ignored'
import { ChannelStatus } from './components/channel-status'
import { FolderForm } from './components/folder-form'
import { FolderDetail } from './components/folder-detail'
import { DeviceDetail } from './components/device-detail'
import { Settings } from './components/settings'
import { SyncthingGate } from './components/syncthing-gate'
import { Tip } from './components/tip'
import { initial } from './lib/initial'
import { detailPath, formPath, parseRoute } from './lib/route'
import {
  api,
  available,
  clearLocal,
  desktop,
  events,
  MOCK_BAR_KEY,
  webPreview,
  type PendingFolder,
  type Settings as SettingsData,
} from './lib/runtime'

// DEV：侧栏“调试”页（照 FoxNudge）和 Mock 模式的右下角小浮窗，生产构建整体剔除
const DebugPage = import.meta.env.DEV
  ? lazy(() =>
      import('./debug/debug-page').then((m) => ({ default: m.DebugPage })),
    )
  : null
const MockBar = import.meta.env.DEV
  ? lazy(() => import('./debug/mock-bar').then((m) => ({ default: m.MockBar })))
  : null

function readMockBar() {
  try {
    return import.meta.env.DEV && localStorage.getItem(MOCK_BAR_KEY) === '1'
  } catch {
    return false
  }
}

const pages = [
  { id: 'folders', title: '文件夹', icon: FolderSync },
  { id: 'devices', title: '设备', icon: MonitorSmartphone },
  ...(DebugPage
    ? [
        {
          id: 'debug',
          title: '调试',
          icon: Bug,
          className: 'text-amber-600 dark:text-amber-400',
        },
      ]
    : []),
]

export function App() {
  const [snapshot, setSnapshot] = useState(initial)
  const [loaded, setLoaded] = useState(false)
  const [working, setWorking] = useState(false)
  // 当前页面、详情抽屉、新建 / 加入抽屉都由 hash 地址决定（wouter），刷新停在原处
  const [location, navigate] = useLocation()
  const route = parseRoute(location, [...pages.map((p) => p.id), 'settings'])
  const page = route.page
  const detail = route.detail
  // 加入的邀请已经不在了（加入了、被忽略了）就当没打开
  const joining = route.form?.join
    ? snapshot.syncthing.pendingFolders.find((p) => p.id === route.form?.join)
    : null
  const dialog: { open: boolean; joining: PendingFolder | null } =
    route.form && (route.form.join === null || joining)
      ? { open: true, joining: joining ?? null }
      : { open: false, joining: null }
  const setPage = (p: string) => navigate(`/${p}`)
  const setDetail = (d: { kind: 'folder' | 'device'; id: string } | null) =>
    navigate(d ? detailPath(d) : `/${page}`)
  const setDialog = (d: { open: boolean; joining: PendingFolder | null }) =>
    navigate(d.open ? formPath(d.joining?.id ?? null) : '/folders')
  // DEV：调试页里的 Mock 模式开关，打开后各页面右下角出现本页的状态浮窗
  const [mockBar, setMockBarState] = useState(readMockBar)
  const setMockBar = (on: boolean) => {
    setMockBarState(on)
    try {
      if (on) localStorage.setItem(MOCK_BAR_KEY, '1')
      else localStorage.removeItem(MOCK_BAR_KEY)
    } catch {}
  }
  const running = useRef(false)

  async function refresh() {
    setSnapshot(await api.snapshot())
  }

  useEffect(() => {
    let disposed = false
    const stops: Promise<() => void>[] = [
      events.snapshot((s) => !disposed && setSnapshot(s)),
      events.syncthing(
        (syncthing) => !disposed && setSnapshot((s) => ({ ...s, syncthing })),
      ),
      events.joined((label) =>
        toast.success(`已自动加入「${label}」`, { id: `joined-${label}` }),
      ),
      events.channel(
        (channel) => !disposed && setSnapshot((s) => ({ ...s, channel })),
      ),
      events.navigate((p) => {
        if (disposed) return
        setPage(p)
      }),
      events.error((text) => toast.error(text, { id: 'backend-error' })),
    ]
    api
      .snapshot()
      .then((s) => {
        if (disposed) return
        setSnapshot(s)
        setLoaded(true)
      })
      .catch((e) => toast.error(String(e), { id: 'connection-error' }))
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setPage('settings')
      }
    }
    // 前端异常经 Rust 统一脱敏写入调试日志
    const onError = (e: ErrorEvent) =>
      void api
        .logClient('error', 'window-error', {
          error: e.message,
          file: e.filename,
          line: e.lineno,
        })
        .catch(() => {})
    const onRejection = (e: PromiseRejectionEvent) =>
      void api
        .logClient('error', 'unhandled-rejection', { error: String(e.reason) })
        .catch(() => {})
    // 窗口回到前台时立刻刷新一次 Syncthing 状态，不等下一轮
    const onFocus = () => void api.refreshSyncthing().catch(() => {})
    window.addEventListener('keydown', key)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      stops.forEach((s) => void s.then((stop) => stop()))
      window.removeEventListener('keydown', key)
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () =>
      document.documentElement.classList.toggle(
        'dark',
        snapshot.settings.theme === 'dark' ||
          (snapshot.settings.theme === 'system' && media.matches),
      )
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [snapshot.settings.theme])

  async function run(work: () => Promise<unknown>) {
    if (running.current) return false
    running.current = true
    // 超过 300ms 才把控件置为忙碌，短操作不会让整页闪一下
    const busy = setTimeout(() => setWorking(true), 300)
    try {
      await work()
      await refresh()
      return true
    } catch (e) {
      toast.error(String(e), { id: 'action-error' })
      return false
    } finally {
      clearTimeout(busy)
      running.current = false
      setWorking(false)
    }
  }

  function save(settings: SettingsData) {
    return run(() => api.saveSettings(settings))
  }

  // DEV：把当前界面状态同步给 __DEBUG__.sync.app 探针
  useEffect(() => {
    if (!import.meta.env.DEV) return
    void import('./debug/app-debug').then(({ appDebug }) =>
      appDebug.sync({
        snapshot,
        loaded,
        page,
        setPage,
        dialog,
        setDialog,
        detail,
        setDetail,
        refresh,
      }),
    )
  })

  const s = snapshot.syncthing
  const disabled = !available || working
  const title = pages.find((p) => p.id === page)?.title
  const ready = s.state === 'ok'
  // 详情里的对象被删了（停止同步、移除设备）就自动回到列表
  const debugProps = {
    snapshot,
    navigate: setPage,
    openDialog: (joining: PendingFolder | null) =>
      setDialog({ open: true, joining }),
    openDetail: (kind: 'folder' | 'device', id: string) =>
      setDetail({ kind, id }),
  }
  // 新建 / 加入是文件夹页里的一整页，开着时盖住列表和详情
  const formOpen = page === 'folders' && dialog.open
  const openFolder =
    page === 'folders' && detail?.kind === 'folder'
      ? s.folders.find((f) => f.id === detail.id)
      : undefined
  const openDevice =
    page === 'devices' && detail?.kind === 'device'
      ? s.devices.find((d) => d.id === detail.id)
      : undefined
  // 抽屉里放哪个二级页面；关闭的动画期间沿用上一次的内容，免得内容先消失
  const sheetOpen = ready && (formOpen || !!openFolder || !!openDevice)
  const closeSheet = () => {
    navigate(`/${page}`)
  }
  const sheetBody = !ready ? null : formOpen ? (
    <FolderForm
      key={dialog.joining?.id ?? 'new'}
      pending={dialog.joining}
      devices={s.devices}
      peers={snapshot.peers}
      joinRoot={snapshot.settings.joinRoot}
      disabled={disabled}
      back={() => setDialog({ open: false, joining: null })}
      submit={(request) =>
        run(() => api.createFolder(request)).then((ok) => {
          if (ok)
            toast.success(
              request.id
                ? `已加入「${request.label.trim()}」`
                : `已新建「${request.label.trim()}」`,
              {
                id: 'folder',
              },
            )
          return ok
        })
      }
    />
  ) : openFolder ? (
    <FolderDetail
      folder={openFolder}
      devices={s.devices}
      peers={snapshot.peers}
      autoShare={snapshot.autoShare.includes(openFolder.id)}
      disabled={disabled}
      run={run}
      back={() => setDetail(null)}
    />
  ) : openDevice ? (
    <DeviceDetail
      device={openDevice}
      folders={s.folders}
      peers={snapshot.peers}
      autoShare={snapshot.autoShare}
      disabled={disabled}
      run={run}
      back={() => setDetail(null)}
    />
  ) : null
  const lastSheet = useRef<ReactNode>(null)
  if (sheetOpen) lastSheet.current = sheetBody
  // 当前页面对应的 Mock 浮窗：对话框开着时是对话框的，详情页是这个对象的
  const mockTarget: { target: string; id?: string } | null = formOpen
    ? { target: 'dialog' }
    : openFolder
      ? { target: 'folder', id: openFolder.id }
      : openDevice
        ? { target: 'device', id: openDevice.id }
        : page === 'folders' || page === 'devices' || page === 'settings'
          ? { target: page }
          : null
  // 侧栏上的数字：有多少可加入的文件夹、请求连接的设备
  const badges: Record<string, number> = {
    folders: s.pendingFolders.length,
    devices: s.pendingDevices.length,
  }

  return (
    <div className='flex h-screen overflow-hidden'>
      {MockBar && mockBar && mockTarget && (
        <Suspense fallback={null}>
          <MockBar
            target={mockTarget.target}
            id={mockTarget.id}
            restored={refresh}
          />
        </Suspense>
      )}
      {/* 二级页面（新建 / 加入、文件夹详情、设备详情）都在右侧抽屉里，盖在列表上；关掉回到列表 */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent>{sheetOpen ? sheetBody : lastSheet.current}</SheetContent>
      </Sheet>
      <Toaster
        position='top-right'
        theme={
          snapshot.settings.theme === 'dark'
            ? 'dark'
            : snapshot.settings.theme === 'light'
              ? 'light'
              : 'system'
        }
        offset={{ top: desktop ? 52 : 16, right: 16 }}
      />
      <aside className='flex w-44 shrink-0 flex-col border-r bg-sidebar px-3 pb-3'>
        {/* 红绿灯所在的一行：留空可拖动，内容从下一行开始 */}
        {desktop && (
          <div
            data-tauri-drag-region
            className='-mx-3 mb-3 h-11 shrink-0 select-none'
          />
        )}
        <div
          className={`mb-4 flex items-center gap-2 px-2 font-semibold ${desktop ? '' : 'pt-3'}`}
        >
          <img src='/app-icon.png' alt='' className='size-6 rounded-md' />
          FoxSync
        </div>
        <nav className='space-y-1'>
          {pages.map((item) => (
            <Button
              key={item.id}
              className={`w-full justify-start ${'className' in item ? item.className : ''}`}
              variant={page === item.id ? 'secondary' : 'ghost'}
              onClick={() => {
                setPage(item.id)
              }}
            >
              <item.icon />
              {item.title}
              {ready && badges[item.id] > 0 && (
                <span className='ml-auto rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground'>
                  {badges[item.id]}
                </span>
              )}
            </Button>
          ))}
        </nav>
        <div className='mt-auto space-y-2'>
          {!desktop && (
            <span className='block px-2 text-amber-600 dark:text-amber-400'>
              {webPreview ? 'Web 模拟' : '浏览器只读预览'}
            </span>
          )}
          <Button
            className='w-full justify-start'
            variant={page === 'settings' ? 'secondary' : 'ghost'}
            onClick={() => setPage('settings')}
          >
            <SettingsIcon />
            设置
          </Button>
        </div>
      </aside>
      <div className='flex min-w-0 flex-1 flex-col'>
        {desktop && (
          <div data-tauri-drag-region className='h-11 shrink-0 select-none' />
        )}
        {/* 始终带着（透明的）滚动条轨道，内容变长时宽度不变；scrollbar-gutter 在 WebKit 里预留的宽度和自定义滚动条对不上，会跳几个像素 */}
        <main
          className={`app-scroll flex min-h-0 flex-1 flex-col overflow-y-scroll p-4 ${desktop ? 'pt-0' : ''}`}
        >
          {(page === 'folders' || page === 'devices') && (
            <>
              <div className='mb-3 flex items-center gap-3'>
                <h2 className='font-medium'>{title}</h2>
                <div className='ml-auto'>
                  <ChannelStatus
                    channel={snapshot.channel}
                    peers={snapshot.peers.length}
                    onReconnect={() => void run(api.reconnectChannel)}
                  />
                </div>
                {ready && (
                  <div className='flex gap-1'>
                    {page === 'folders' && (
                      <Tip content='新建文件夹'>
                        <Button
                          variant='ghost'
                          size='icon'
                          aria-label='新建文件夹'
                          disabled={disabled}
                          onClick={() =>
                            setDialog({ open: true, joining: null })
                          }
                        >
                          <FolderPlus />
                        </Button>
                      </Tip>
                    )}
                    <Tip content='刷新'>
                      <Button
                        variant='ghost'
                        size='icon'
                        aria-label='刷新'
                        disabled={disabled}
                        onClick={() => void run(api.refreshSyncthing)}
                      >
                        <RotateCw />
                      </Button>
                    </Tip>
                  </div>
                )}
              </div>
              {!ready ? (
                <SyncthingGate
                  syncthing={s}
                  disabled={disabled}
                  run={run}
                  api={{
                    launch: api.launchSyncthing,
                    refresh: api.refreshSyncthing,
                    takeOver: api.syncthingTakeOver,
                  }}
                />
              ) : page === 'folders' ? (
                <>
                  <Folders
                    folders={s.folders}
                    devices={s.devices}
                    peers={snapshot.peers}
                    pending={s.pendingFolders}
                    disabled={disabled}
                    reveal={(path) => void run(() => api.revealPath(path))}
                    open={(id) => setDetail({ kind: 'folder', id })}
                    toggle={(f) =>
                      void run(() =>
                        api.folderAction(f.id, f.paused ? 'resume' : 'pause'),
                      )
                    }
                    create={() => setDialog({ open: true, joining: null })}
                    join={(p) =>
                      p.existing
                        ? void run(async () => {
                            for (const d of p.offeredBy)
                              await api.shareFolder(d, p.id, true)
                          }).then(
                            (ok) =>
                              ok &&
                              toast.success(`已共享「${p.label || p.id}」`, {
                                id: 'folder',
                              }),
                          )
                        : setDialog({ open: true, joining: p })
                    }
                    ignore={(p) =>
                      void run(() => api.ignoreFolder(p.id)).then(
                        (ok) =>
                          ok &&
                          offerUndo(`已忽略「${p.label || p.id}」`, () =>
                            // 恢复时会让对方短暂重连，邀请马上回到“可加入”
                            run(async () => {
                              for (const d of p.offeredBy)
                                await api.restoreIgnored(d, p.id)
                            }),
                          ),
                      )
                    }
                  />
                  <IgnoredFolders
                    list={s.ignoredFolders}
                    devices={s.devices}
                    peers={snapshot.peers}
                    disabled={disabled}
                    run={run}
                  />
                </>
              ) : (
                <>
                  <Devices
                    devices={s.devices}
                    peers={snapshot.peers}
                    pending={s.pendingDevices}
                    ignored={s.ignoredDevices}
                    identity={snapshot.identity}
                    avatarStyle={snapshot.settings.avatarStyle}
                    disabled={disabled}
                    accept={(d) =>
                      void run(() => api.acceptDevice(d.id)).then(
                        (ok) =>
                          ok &&
                          toast.success(`已添加 ${d.name || '设备'}`, {
                            id: 'device',
                          }),
                      )
                    }
                    ignore={(d) =>
                      void run(() => api.ignoreDevice(d.id)).then(
                        (ok) =>
                          ok &&
                          offerUndo(`已忽略 ${d.name || '这台设备'}`, () =>
                            run(() => api.restoreDevice(d.id)).then(
                              (ok) =>
                                ok &&
                                // 请求要等对方下次来连才重新出现，不会马上回来
                                toast(
                                  `${d.name || '这台设备'}下次来连时会出现在请求连接里`,
                                  { id: 'device' },
                                ),
                            ),
                          ),
                      )
                    }
                    add={(p) =>
                      void run(() => api.addPeer(p.id)).then(
                        (ok) =>
                          ok &&
                          toast.success(`已添加 ${p.name || '设备'}`, {
                            id: 'device',
                          }),
                      )
                    }
                    open={(id) => setDetail({ kind: 'device', id })}
                    setOnline={(online) =>
                      void run(() => api.setOnline(online)).then(
                        (ok) =>
                          ok &&
                          toast.success(
                            online ? '已上线' : '已离线，暂停和所有设备的同步',
                            { id: 'online' },
                          ),
                      )
                    }
                  />
                  <IgnoredDevices
                    list={s.ignoredDevices}
                    disabled={disabled}
                    run={run}
                  />
                </>
              )}
            </>
          )}
          {page === 'settings' && (
            <Settings
              snapshot={snapshot}
              disabled={disabled}
              save={save}
              run={run}
              wiped={() => {
                clearLocal()
                setMockBar(false)
              }}
            />
          )}
          {page === 'debug' && DebugPage && (
            <Suspense fallback={null}>
              <DebugPage
                {...debugProps}
                mockBar={mockBar}
                setMockBar={setMockBar}
              />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  )
}
