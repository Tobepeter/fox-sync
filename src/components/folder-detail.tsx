import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, FolderOpen, ScanSearch } from 'lucide-react'
import { Badge } from './ui/badge'
import { SheetBody, SheetHeader } from './ui/sheet'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
import { Avatar } from './avatar'
import { Choice } from './choice'
import { ConfirmAction } from './confirm-action'
import { HelpTip } from './help-tip'
import { LargeFiles } from './large-files'
import { OverflowText } from './overflow-text'
import { Tip } from './tip'
import { issues, State } from './folders'
import { face } from '../lib/face'
import { offerUndo } from '../lib/undo'
import { folderKinds, formatBytes, formatSeen, syncError } from '../lib/format'
import {
  api,
  MOCK_EVENT,
  type Device,
  type FileIssue,
  type Folder,
  type Member,
  type Peer,
} from '../lib/runtime'

const KINDS = [
  { value: 'sendreceive', label: '双向同步' },
  { value: 'sendonly', label: '仅发送' },
  { value: 'receiveonly', label: '仅接收' },
]

export function Section(props: {
  title: string
  help?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className='space-y-1.5'>
      <div className='flex min-h-7 items-center justify-between gap-2'>
        <h3 className='flex items-center gap-0.5 text-muted-foreground'>
          {props.title}
          {props.help && <HelpTip label={props.title}>{props.help}</HelpTip>}
        </h3>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

export function Row(props: {
  label: string
  help?: ReactNode
  children: ReactNode
}) {
  return (
    <div className='flex min-h-10 items-center justify-between gap-4 px-3 py-1.5'>
      {/* 标签不收缩不换行，右侧占剩下的宽度，放不下的内容自己截断 */}
      <span className='flex shrink-0 items-center gap-0.5 whitespace-nowrap'>
        {props.label}
        {props.help && <HelpTip label={props.label}>{props.help}</HelpTip>}
      </span>
      <div className='flex min-w-0 flex-1 items-center justify-end gap-2'>
        {props.children}
      </div>
    </div>
  )
}

/** 失焦或回车保存，Esc 还原 */
export function InlineText(props: {
  value: string
  disabled?: boolean
  onSave: (v: string) => void
  className?: string
}) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  const commit = () =>
    value.trim() && value.trim() !== props.value
      ? props.onSave(value.trim())
      : setValue(props.value)
  return (
    <Input
      className={props.className ?? 'w-56'}
      value={value}
      disabled={props.disabled}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing)
          (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setValue(props.value)
      }}
    />
  )
}

/** 抽屉顶部：标题在左，关闭在右（二级页面都放在右侧抽屉里） */
export function DetailHeader(props: { children: ReactNode }) {
  return <SheetHeader>{props.children}</SheetHeader>
}

const card = 'divide-y rounded-lg border bg-card'

/** 对方对这个文件夹的情况：已同步 / 同步到多少 / 等待加入 / 已暂停 / 离线 */
export function memberText(m: Member | undefined) {
  if (!m || m.state === 'unknown')
    return { text: '离线', tone: 'text-muted-foreground' }
  if (m.state === 'notSharing')
    return { text: '等待加入', tone: 'text-amber-600 dark:text-amber-400' }
  if (m.state === 'paused')
    return { text: '已暂停', tone: 'text-muted-foreground' }
  return m.completion >= 100
    ? { text: '已同步', tone: 'text-muted-foreground' }
    : {
        text: `同步中 ${Math.floor(m.completion)}%`,
        tone: 'text-muted-foreground',
      }
}

function MemberState(props: { member: Member | undefined }) {
  const t = memberText(props.member)
  return (
    <Tip content={t.text === '等待加入' ? '对方还没加入，或者忽略了' : null}>
      <span className={`shrink-0 ${t.tone}`}>{t.text}</span>
    </Tip>
  )
}

/** 在访达里显示 .stignore；目录里还没有时先问要不要新建，确认后建好再显示 */
function OpenIgnores(props: {
  path: string
  disabled: boolean
  create: () => Promise<boolean>
  reveal: (file: string) => void
}) {
  const [open, setOpen] = useState(false)
  const file = `${props.path}/.stignore`
  async function click() {
    const info = await api.inspectPath(props.path).catch(() => null)
    if (info?.hasIgnores) props.reveal(file)
    else setOpen(true)
  }
  return (
    // 只由点击后的检查来打开，触发器自己的开关请求忽略掉
    <Popover open={open} onOpenChange={(next) => !next && setOpen(false)}>
      <PopoverTrigger
        render={
          <Button variant='outline' size='sm' onClick={() => void click()} />
        }
      >
        <FolderOpen />
        打开
      </PopoverTrigger>
      <PopoverContent align='end' className='space-y-3'>
        <p>目录里还没有 .stignore，新建一个？</p>
        <div className='flex justify-end gap-2'>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            disabled={props.disabled}
            onClick={() =>
              void props.create().then((ok) => {
                setOpen(false)
                if (ok) props.reveal(file)
              })
            }
          >
            新建
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Stat(props: { label: string; children: ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-0.5 px-3 py-2'>
      <span className='text-muted-foreground'>{props.label}</span>
      <span className='min-w-0'>{props.children}</span>
    </div>
  )
}

/** 冲突副本名里带着改它的设备的短 ID（.sync-conflict-日期-时间-短ID），换成设备名 */
function conflictFrom(path: string, devices: Device[], peers: Peer[]) {
  const short = path.match(/\.sync-conflict-\d{8}-\d{6}-([A-Z0-9]{7})/)?.[1]
  const d = short && devices.find((x) => x.id.startsWith(short))
  return d ? face(d, peers).name || '另一台设备' : '另一台设备'
}

export function FolderDetail(props: {
  folder: Folder
  devices: Device[]
  peers: Peer[]
  autoShare: boolean
  disabled: boolean
  run: (work: () => Promise<unknown>) => Promise<boolean>
  back: () => void
}) {
  const f = props.folder
  const [conflicts, setConflicts] = useState<FileIssue[]>([])
  const [errors, setErrors] = useState<FileIssue[]>([])
  const [ignores, setIgnores] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [draft, setDraft] = useState('')
  // 撤销是 5 秒后点的，要拿点那一刻的规则和草稿
  const saved = useRef<{ ignores: string | null; draft: string }>({
    ignores: null,
    draft: '',
  })
  saved.current = { ignores, draft }
  const others = props.devices.filter((d) => !d.me)
  const isPeer = (id: string) => props.peers.some((p) => p.syncthingId === id)

  // DEV：Mock 切了状态（比如“有设备等待加入”）时加入情况不在快照里，重拉一次
  const [mockTick, setMockTick] = useState(0)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onMock = () => setMockTick((n) => n + 1)
    window.addEventListener(MOCK_EVENT, onMock)
    return () => window.removeEventListener(MOCK_EVENT, onMock)
  }, [])
  // 每台设备有没有加入、同步到多少；共享列表、连接、进度变了就重拉
  const memberKey = `${f.devices.join(',')}|${props.devices.map((d) => `${d.id}:${d.connected}`).join(',')}|${f.needBytes}|${f.state}`
  useEffect(() => {
    void api
      .folderMembers(f.id)
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [f.id, memberKey, mockTick])
  // 冲突和出错文件按需拉：数量变了就重拉
  useEffect(() => {
    void api
      .folderConflicts(f.id)
      .then(setConflicts)
      .catch(() => setConflicts([]))
  }, [f.id, f.conflicts])
  useEffect(() => {
    if (f.errorItems === 0) return setErrors([])
    void api
      .folderErrors(f.id)
      .then(setErrors)
      .catch(() => setErrors([]))
  }, [f.id, f.errorItems])
  useEffect(() => {
    void api.folderIgnores(f.id).then((text) => {
      setIgnores(text)
      setDraft(text)
    })
  }, [f.id])

  const act = (work: () => Promise<unknown>, done?: string) =>
    void props
      .run(work)
      .then((ok) => ok && done && toast.success(done, { id: 'folder-detail' }))
  const update = (
    patch: Parameters<typeof api.updateFolder>[1],
    done?: string,
  ) => act(() => api.updateFolder(f.id, patch), done)
  // 冲突处理立即生效，5 秒内可撤销：后端动手前留了快照，撤销时原样放回（以快照为准）
  async function resolve(c: FileIssue, choice: 'keep' | 'drop') {
    let token = ''
    const ok = await props.run(async () => {
      token = await api.resolveConflict(f.id, c.path, choice)
    })
    if (!ok) return
    const name = c.detail.split('/').pop() || c.detail
    offerUndo(
      choice === 'drop'
        ? `已丢掉「${name}」的另一份`
        : `已用另一份替换「${name}」`,
      () => props.run(() => api.undoConflict(f.id, token)),
    )
  }
  const pending = issues(f)
  const shared = (id: string) => f.devices.includes(id)
  const locked = (id: string) => props.autoShare && isPeer(id)

  return (
    <>
      <DetailHeader>
        <h2 className='truncate font-medium'>{f.label || f.id}</h2>
        {folderKinds[f.kind] && (
          <Badge variant='secondary'>{folderKinds[f.kind]}</Badge>
        )}
      </DetailHeader>
      <SheetBody className='space-y-5'>
        <div className='grid grid-cols-3 divide-x rounded-lg border bg-card'>
          <Stat label='状态'>
            <State folder={f} />
          </Stat>
          <Stat label='大小'>
            {formatBytes(f.globalBytes)} · {f.globalItems.toLocaleString()} 项
          </Stat>
          <Stat label='还差'>
            {f.needBytes > 0
              ? `${formatBytes(f.needBytes)} · ${f.needItems} 项`
              : '—'}
          </Stat>
        </div>
        {f.error && (
          <p className='-mt-3 text-destructive'>{syncError(f.error)}</p>
        )}

        {(pending.length > 0 || conflicts.length > 0) && (
          <Section title='需要处理'>
            <div className={card}>
              {conflicts.map((c) => (
                <div key={c.path} className='flex items-center gap-3 px-3 py-2'>
                  <Tip content={c.path}>
                    <div className='flex min-w-0 flex-1 flex-col'>
                      <span className='truncate'>{c.detail}</span>
                      <span className='truncate text-muted-foreground'>
                        {conflictFrom(c.path, props.devices, props.peers)}{' '}
                        改的另一份
                        {c.time
                          ? ` · ${formatSeen(new Date(c.time * 1000).toISOString())}`
                          : ''}
                      </span>
                    </div>
                  </Tip>
                  <Tip content='在访达中显示'>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label='在访达中显示'
                      onClick={() =>
                        act(() => api.revealFile(`${f.path}/${c.path}`))
                      }
                    >
                      <FolderOpen />
                    </Button>
                  </Tip>
                  <Tip content='丢掉这份副本，挪进废纸篓'>
                    <Button
                      variant='ghost'
                      disabled={props.disabled}
                      onClick={() => resolve(c, 'drop')}
                    >
                      丢掉
                    </Button>
                  </Tip>
                  <Tip content='用这份替换原文件，原文件挪进废纸篓'>
                    <Button
                      variant='outline'
                      disabled={props.disabled}
                      onClick={() => resolve(c, 'keep')}
                    >
                      用这份
                    </Button>
                  </Tip>
                </div>
              ))}
              {errors.map((e) => (
                <div key={e.path} className='flex items-center gap-3 px-3 py-2'>
                  <div className='flex min-w-0 flex-1 flex-col'>
                    <OverflowText text={e.path} />
                    <OverflowText
                      text={syncError(e.detail)}
                      className='text-destructive'
                    />
                  </div>
                </div>
              ))}
              {f.kind === 'sendonly' && f.needItems > 0 && (
                <div className='flex items-center gap-3 px-3 py-2'>
                  <span className='flex-1'>
                    别的设备改了 {f.needItems} 项，本机是仅发送，没有采纳
                  </span>
                  <ConfirmAction
                    label='以本机为准'
                    description='用本机的版本覆盖其他设备上的改动？'
                    disabled={props.disabled}
                    onConfirm={() =>
                      props.run(() => api.folderAction(f.id, 'override'))
                    }
                  />
                </div>
              )}
              {f.kind === 'receiveonly' && f.localChanges > 0 && (
                <div className='flex items-center gap-3 px-3 py-2'>
                  <span className='flex-1'>
                    本机改了 {f.localChanges} 项，仅接收不会发出去
                  </span>
                  <ConfirmAction
                    label='撤销本地改动'
                    description='丢掉本机的改动，恢复成其他设备上的版本？'
                    disabled={props.disabled}
                    onConfirm={() =>
                      props.run(() => api.folderAction(f.id, 'revert'))
                    }
                  />
                </div>
              )}
            </div>
          </Section>
        )}

        <Section title='共享'>
          <div className={card}>
            <Row
              label='频道里的所有设备'
              help='以后经频道配对的设备也会自动收到邀请'
            >
              <Switch
                checked={props.autoShare}
                disabled={props.disabled}
                onCheckedChange={(autoShare) => update({ autoShare })}
              />
            </Row>
            {others.map((d) => {
              const who = face(d, props.peers)
              return (
                <div
                  key={d.id}
                  className='flex min-h-10 items-center gap-2 px-3 py-1.5'
                >
                  <Avatar
                    id={who.id}
                    name={who.name}
                    avatar={who.avatar}
                    size={22}
                  />
                  <span
                    className={`flex-1 truncate ${d.connected ? '' : 'text-muted-foreground'}`}
                  >
                    {who.name || '未命名设备'}
                  </span>
                  {shared(d.id) && (
                    <MemberState
                      member={members.find((m) => m.device === d.id)}
                    />
                  )}
                  <Tip
                    content={
                      locked(d.id)
                        ? '自动共享给频道设备，关掉上面的开关才能单独设置'
                        : null
                    }
                  >
                    <span>
                      <Switch
                        checked={shared(d.id) || locked(d.id)}
                        disabled={props.disabled || locked(d.id)}
                        aria-label={`共享给 ${who.name}`}
                        onCheckedChange={(on) =>
                          act(() => api.shareFolder(d.id, f.id, on))
                        }
                      />
                    </span>
                  </Tip>
                </div>
              )
            })}
          </div>
        </Section>

        <Section title='设置'>
          <div className={card}>
            <Row label='同步' help='关掉就暂停这个文件夹，不收也不发'>
              <Switch
                checked={!f.paused}
                disabled={props.disabled}
                aria-label='同步'
                onCheckedChange={(on) =>
                  act(() => api.folderAction(f.id, on ? 'resume' : 'pause'))
                }
              />
            </Row>
            <Row label='名称' help='只在这台电脑上显示'>
              <InlineText
                value={f.label}
                disabled={props.disabled}
                onSave={(label) => update({ label })}
              />
            </Row>
            <Row label='同步方向' help='仅发送：只发不收；仅接收：只收不发'>
              <Choice
                label='同步方向'
                value={f.kind}
                options={KINDS}
                disabled={props.disabled}
                onChange={(kind) => update({ kind })}
              />
            </Row>
            <Row
              label='保留旧版本'
              help='别的设备删除或覆盖的文件保留 30 天，在 .stversions 里'
            >
              <Switch
                checked={f.versioning}
                disabled={props.disabled}
                onCheckedChange={(versioning) => update({ versioning })}
              />
            </Row>
            <Row label='位置'>
              <OverflowText text={f.path} className='text-muted-foreground' />
              <Button
                variant='outline'
                size='sm'
                onClick={() => act(() => api.revealPath(f.path))}
              >
                <FolderOpen />
                打开
              </Button>
            </Row>
          </div>
        </Section>

        <LargeFiles
          folder={f}
          disabled={props.disabled}
          ignoreBlocked={ignores === null || draft !== ignores}
          reveal={(path) => act(() => api.revealFile(path))}
          ignore={async (path) => {
            let added = false
            const ok = await props.run(async () => {
              const text = await api.ignoreFile(f.id, path)
              added = text !== saved.current.ignores
              setIgnores(text)
              setDraft(text)
            })
            return ok ? (added ? 'added' : 'kept') : null
          }}
          unignore={(path) =>
            props.run(async () => {
              const text = await api.unignoreFile(f.id, path)
              // 期间手动改了规则还没保存的话，草稿不动
              const { ignores: before, draft: current } = saved.current
              if (current === before) setDraft(text)
              setIgnores(text)
            })
          }
        />

        <Section
          title='忽略规则'
          help='就是目录里的 .stignore，只对这台电脑生效'
          action={
            ignores !== null && draft === ignores ? (
              <OpenIgnores
                path={f.path}
                disabled={props.disabled}
                create={() =>
                  props.run(() => api.setFolderIgnores(f.id, draft))
                }
                reveal={(file) => act(() => api.revealFile(file))}
              />
            ) : (
              ignores !== null && (
                <div className='flex gap-1'>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => setDraft(ignores)}
                  >
                    还原
                  </Button>
                  <Button
                    size='sm'
                    disabled={props.disabled}
                    onClick={() =>
                      void props
                        .run(() => api.setFolderIgnores(f.id, draft))
                        .then((ok) => {
                          if (!ok) return
                          setIgnores(draft)
                          toast.success('已保存忽略规则', {
                            id: 'folder-detail',
                          })
                        })
                    }
                  >
                    保存
                  </Button>
                </div>
              )
            )
          }
        >
          <Textarea
            className='min-h-32 font-mono text-xs'
            value={draft}
            disabled={ignores === null}
            placeholder={'每行一条，比如：\nnode_modules\n*.log'}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Section>

        <div className='flex justify-end gap-2'>
          <Button
            variant='outline'
            disabled={props.disabled || f.paused}
            onClick={() =>
              act(() => api.folderAction(f.id, 'rescan'), '已开始重新扫描')
            }
          >
            <ScanSearch />
            重新扫描
          </Button>
          <ConfirmAction
            label='停止同步'
            description='从 Syncthing 里移除这个文件夹？本地文件保留，其他设备不受影响'
            success='已停止同步'
            disabled={props.disabled}
            trigger={
              <Button
                variant='outline'
                className='text-destructive'
                disabled={props.disabled}
              >
                停止同步
              </Button>
            }
            onConfirm={() =>
              props
                .run(() => api.removeFolder(f.id))
                .then((ok) => {
                  if (ok) props.back()
                  return ok
                })
            }
          />
        </div>
      </SheetBody>
    </>
  )
}
