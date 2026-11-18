import {
  AlertTriangle,
  ArrowUpFromLine,
  ChevronRight,
  Copy,
  FolderInput,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  Undo2,
} from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Avatar } from './avatar'
import { OverflowText } from './overflow-text'
import { Tip } from './tip'
import {
  folderKinds,
  folderState,
  formatBytes,
  formatSeen,
} from '../lib/format'
import type { Device, Folder, PendingFolder, Peer } from '../lib/runtime'
import { face } from '../lib/face'

const tones = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
  busy: '',
}

export function State(props: { folder: Folder }) {
  const f = props.folder
  const state = folderState(f.state, f.needBytes)
  const detail =
    f.error || (f.needBytes > 0 ? `还差 ${formatBytes(f.needBytes)}` : '')
  return (
    <Tip content={detail || null}>
      <span className='flex shrink-0 items-center gap-1.5 text-muted-foreground'>
        {state.tone === 'busy' ? (
          <LoaderCircle className='size-3.5 animate-spin' />
        ) : (
          <span className={`size-2 rounded-full ${tones[state.tone]}`} />
        )}
        {state.text}
      </span>
    </Tip>
  )
}

// 共享给了哪些设备：头像叠在一起，悬停看名字
// 最多显示 4 个头像，再多就显示前 3 个加“+N”，悬停“+N”列出其余的；在线的排前面
const MAX_FACES = 4

export function Members(props: {
  ids: string[]
  devices: Device[]
  peers: Peer[]
}) {
  const members = props.ids
    .map((id) => {
      const d = props.devices.find((x) => x.id === id) ?? {
        id,
        name: '未知设备',
        connected: false,
      }
      return { ...face(d, props.peers), key: id, connected: d.connected }
    })
    .sort((a, b) => Number(b.connected) - Number(a.connected))
  if (members.length === 0)
    return <span className='text-muted-foreground'>未共享</span>
  const shown =
    members.length > MAX_FACES ? members.slice(0, MAX_FACES - 1) : members
  const rest = members.slice(shown.length)
  const label = (d: (typeof members)[number]) =>
    `${d.name}${d.connected ? '' : '（离线）'}`
  return (
    <span className='flex shrink-0 -space-x-1.5'>
      {shown.map((d) => (
        <Tip key={d.key} content={label(d)}>
          <span
            className={`rounded-full ring-2 ring-card ${d.connected ? '' : 'opacity-40'}`}
          >
            <Avatar id={d.id} name={d.name} avatar={d.avatar} size={22} />
          </span>
        </Tip>
      ))}
      {rest.length > 0 && (
        <Tip
          content={
            <span className='flex flex-col'>
              {rest.map((d) => (
                <span key={d.key}>{label(d)}</span>
              ))}
            </span>
          }
        >
          <span className='relative flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-muted px-1 text-[11px] font-medium text-muted-foreground tabular-nums ring-2 ring-card'>
            +{rest.length}
          </span>
        </Tip>
      )}
    </span>
  )
}

// 别的设备共享过来、还没加入的：点加入选本地位置，点忽略以后不再提示
// 本机已有这个文件夹（只是没共享给对方）的，按钮是“共享”，把对方加回共享列表
function Invites(props: {
  pending: PendingFolder[]
  devices: Device[]
  peers: Peer[]
  join: (p: PendingFolder) => void
  ignore: (p: PendingFolder) => void
  disabled: boolean
}) {
  return (
    <section className='mb-4 space-y-1.5'>
      <h3 className='text-muted-foreground'>可加入</h3>
      <ul className='divide-y rounded-lg border border-primary/30 bg-card'>
        {props.pending.map((p) => {
          const from = p.offeredBy.map(
            (id) =>
              face(
                props.devices.find((d) => d.id === id) ?? {
                  id,
                  name: '未知设备',
                },
                props.peers,
              ).name,
          )
          const seen = formatSeen(p.time)
          return (
            <li key={p.id} className='flex items-center gap-3 px-3 py-2.5'>
              <span className='flex size-8 shrink-0 items-center justify-center text-muted-foreground'>
                <FolderInput className='size-4' />
              </span>
              <div className='flex min-w-0 flex-1 flex-col'>
                <OverflowText text={p.label || p.id} className='font-medium' />
                <span className='truncate text-muted-foreground'>
                  {from.join('、')}
                  {p.existing ? ' · 本机已有，还没共享给它' : ''}
                  {seen ? ` · ${seen}` : ''}
                </span>
              </div>
              <Members
                ids={p.offeredBy}
                devices={props.devices}
                peers={props.peers}
              />
              <Button
                variant='ghost'
                disabled={props.disabled}
                onClick={() => props.ignore(p)}
              >
                忽略
              </Button>
              <Button disabled={props.disabled} onClick={() => props.join(p)}>
                {p.existing ? '共享' : '加入'}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function Folders(props: {
  folders: Folder[]
  devices: Device[]
  peers: Peer[]
  pending: PendingFolder[]
  disabled: boolean
  reveal: (path: string) => void
  open: (id: string) => void
  toggle: (f: Folder) => void
  join: (p: PendingFolder) => void
  ignore: (p: PendingFolder) => void
  create: () => void
}) {
  return (
    <>
      {props.pending.length > 0 && (
        <Invites
          pending={props.pending}
          devices={props.devices}
          peers={props.peers}
          join={props.join}
          ignore={props.ignore}
          disabled={props.disabled}
        />
      )}
      {props.folders.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-12 text-muted-foreground'>
          还没有同步的文件夹
          <Button
            variant='outline'
            disabled={props.disabled}
            onClick={props.create}
          >
            新建文件夹
          </Button>
        </div>
      ) : (
        <FolderList
          folders={props.folders}
          devices={props.devices}
          peers={props.peers}
          disabled={props.disabled}
          open={props.open}
          reveal={props.reveal}
          toggle={props.toggle}
        />
      )}
    </>
  )
}

/** 状态之外需要用户处理的事，列表行尾和详情共用 */
export function issues(f: Folder) {
  const out: {
    key: string
    text: string
    tone: 'warn' | 'error'
    icon: typeof Copy
  }[] = []
  if (f.conflicts > 0)
    out.push({
      key: 'conflicts',
      text: `${f.conflicts} 个冲突文件`,
      tone: 'warn',
      icon: Copy,
    })
  if (f.errorItems > 0)
    out.push({
      key: 'errors',
      text: `${f.errorItems} 个文件同步失败`,
      tone: 'error',
      icon: AlertTriangle,
    })
  if (f.kind === 'sendonly' && f.needItems > 0)
    out.push({
      key: 'override',
      text: `别的设备改了 ${f.needItems} 项，本机没采纳`,
      tone: 'warn',
      icon: ArrowUpFromLine,
    })
  if (f.kind === 'receiveonly' && f.localChanges > 0)
    out.push({
      key: 'revert',
      text: `本机改了 ${f.localChanges} 项，不会发出去`,
      tone: 'warn',
      icon: Undo2,
    })
  return out
}

function Issues(props: { folder: Folder }) {
  const list = issues(props.folder)
  if (list.length === 0) return null
  return (
    <span className='flex shrink-0 items-center gap-1'>
      {list.map((i) => (
        <Tip key={i.key} content={i.text}>
          <i.icon
            className={`size-3.5 ${i.tone === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}
            aria-label={i.text}
          />
        </Tip>
      ))}
    </span>
  )
}

// 一行：名字和方向、需要处理的标记、成员、状态；悬停出现暂停和在访达打开，点行进详情
function FolderList(props: {
  folders: Folder[]
  devices: Device[]
  peers: Peer[]
  disabled: boolean
  open: (id: string) => void
  reveal: (path: string) => void
  toggle: (f: Folder) => void
}) {
  return (
    <ul className='divide-y rounded-lg border bg-card'>
      {props.folders.map((f) => (
        <li
          key={f.id}
          className='group flex cursor-pointer items-center gap-3 py-2.5 pr-2 pl-3 hover:bg-muted/40'
          onClick={() => props.open(f.id)}
        >
          <div className='flex min-w-0 flex-1 items-center gap-2'>
            <OverflowText text={f.label || f.id} className='font-medium' />
            {folderKinds[f.kind] && (
              <Badge variant='secondary'>{folderKinds[f.kind]}</Badge>
            )}
            <Issues folder={f} />
          </div>
          {/* 悬停才出现，键盘聚焦时也出现 */}
          <span
            className='flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'
            onClick={(e) => e.stopPropagation()}
          >
            <Tip content={f.paused ? '恢复同步' : '暂停同步'}>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label={f.paused ? '恢复同步' : '暂停同步'}
                disabled={props.disabled}
                onClick={() => props.toggle(f)}
              >
                {f.paused ? <Play /> : <Pause />}
              </Button>
            </Tip>
            <Tip content='在访达中打开'>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='在访达中打开'
                onClick={() => props.reveal(f.path)}
              >
                <FolderOpen />
              </Button>
            </Tip>
          </span>
          <Members
            ids={f.devices}
            devices={props.devices}
            peers={props.peers}
          />
          <div className='w-20 shrink-0'>
            <State folder={f} />
          </div>
          <ChevronRight className='size-4 shrink-0 text-muted-foreground' />
        </li>
      ))}
    </ul>
  )
}
