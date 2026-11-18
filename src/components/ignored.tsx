import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, FolderX } from 'lucide-react'
import { Button } from './ui/button'
import { Avatar } from './avatar'
import { face } from '../lib/face'
import { formatSeen } from '../lib/format'
import {
  api,
  type Device,
  type IgnoredFolder,
  type PendingDevice,
  type Peer,
} from '../lib/runtime'

// 列表下方一行折叠的“已忽略 N 个…”，默认收起，点开才列出来，每条都能恢复
function Fold(props: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className='mt-3'>
      <Button
        variant='ghost'
        size='sm'
        className='-ml-2 text-muted-foreground'
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        {props.title}
      </Button>
      {open && (
        <ul className='mt-1 divide-y rounded-lg border bg-card'>
          {props.children}
        </ul>
      )}
    </section>
  )
}

function Row(props: {
  icon: ReactNode
  title: string
  sub: string
  disabled: boolean
  restore: () => void
}) {
  return (
    <li className='flex items-center gap-3 px-3 py-2'>
      {props.icon}
      <div className='flex min-w-0 flex-1 flex-col'>
        <span className='truncate'>{props.title}</span>
        <span className='truncate text-muted-foreground'>{props.sub}</span>
      </div>
      <Button
        variant='outline'
        size='sm'
        disabled={props.disabled}
        onClick={props.restore}
      >
        恢复
      </Button>
    </li>
  )
}

const done = (text: string) => (ok: boolean) =>
  ok && toast.success(text, { id: 'ignored' })

/** 文件夹页：在“可加入”里忽略过的邀请（只忽略这个文件夹，那台设备照常连接），恢复后回到“可加入” */
export function IgnoredFolders(props: {
  list: IgnoredFolder[]
  devices: Device[]
  peers: Peer[]
  disabled: boolean
  run: (work: () => Promise<unknown>) => Promise<boolean>
}) {
  if (props.list.length === 0) return null
  return (
    <Fold title={`已忽略 ${props.list.length} 个邀请`}>
      {props.list.map((f) => {
        const d = props.devices.find((x) => x.id === f.device)
        const from = d
          ? face(d, props.peers).name || '未命名设备'
          : '已移除的设备'
        const seen = formatSeen(f.time)
        return (
          <Row
            key={`${f.device}:${f.id}`}
            icon={
              <span className='flex size-7 shrink-0 items-center justify-center text-muted-foreground'>
                <FolderX className='size-4' />
              </span>
            }
            title={f.label || f.id}
            sub={`来自 ${from}${seen ? ` · ${seen}忽略` : ''}`}
            disabled={props.disabled}
            restore={() =>
              void props
                .run(() => api.restoreIgnored(f.device, f.id))
                .then(done(`「${f.label || f.id}」会回到可加入`))
            }
          />
        )
      })}
    </Fold>
  )
}

/** 设备页：在“请求连接”里忽略过的设备（整台设备），恢复后它下次来连时重新出现在“请求连接” */
export function IgnoredDevices(props: {
  list: PendingDevice[]
  disabled: boolean
  run: (work: () => Promise<unknown>) => Promise<boolean>
}) {
  if (props.list.length === 0) return null
  return (
    <Fold title={`已忽略 ${props.list.length} 台设备`}>
      {props.list.map((d) => {
        const seen = formatSeen(d.time)
        return (
          <Row
            key={d.id}
            icon={<Avatar id={d.id} name={d.name} size={28} />}
            title={d.name || '未命名设备'}
            sub={[d.address, seen && `${seen}忽略`].filter(Boolean).join(' · ')}
            disabled={props.disabled}
            restore={() =>
              void props
                .run(() => api.restoreDevice(d.id))
                .then(
                  done(`${d.name || '这台设备'}下次来连时会出现在请求连接里`),
                )
            }
          />
        )
      })}
    </Fold>
  )
}
