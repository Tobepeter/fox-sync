import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { Avatar } from './avatar'
import { OverflowText } from './overflow-text'
import { connectionKind, formatSeen } from '../lib/format'
import { ChevronRight } from 'lucide-react'
import { Tip } from './tip'
import { face } from '../lib/face'
import type { Device, Identity, PendingDevice, Peer } from '../lib/runtime'

// 还不在设备表里、主动来连本机的设备；接受后加进设备表，Syncthing 自己连上
function Requests(props: {
  pending: PendingDevice[]
  peers: Peer[]
  accept: (d: PendingDevice) => void
  ignore: (d: PendingDevice) => void
  disabled: boolean
}) {
  return (
    <section className='mb-4 space-y-1.5'>
      <h3 className='text-muted-foreground'>请求连接</h3>
      <ul className='divide-y rounded-lg border border-primary/30 bg-card'>
        {props.pending.map((d) => {
          const seen = formatSeen(d.time)
          // 频道里认识的，用它在频道里的头像和昵称
          const f = face(d, props.peers)
          return (
            <li key={d.id} className='flex items-center gap-3 px-3 py-2.5'>
              <Avatar id={f.id} name={f.name} avatar={f.avatar} size={32} />
              <div className='flex min-w-0 flex-1 flex-col'>
                <OverflowText
                  text={f.name || '未命名设备'}
                  className='font-medium'
                />
                <OverflowText
                  text={`${d.id.slice(0, 7)} · ${d.address}${seen ? ` · ${seen}` : ''}`}
                  className='text-muted-foreground'
                />
              </div>
              <Button
                variant='ghost'
                disabled={props.disabled}
                onClick={() => props.ignore(d)}
              >
                忽略
              </Button>
              <Button disabled={props.disabled} onClick={() => props.accept(d)}>
                接受
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// 频道里还没添加的设备：关了自动添加后新发现的，或者移除过的；添加后对方没加本机的话，会在它那边出现“请求连接”
// 已经在“请求连接”里的不重复列
function Others(props: {
  peers: Peer[]
  add: (p: Peer) => void
  disabled: boolean
}) {
  return (
    <section className='mt-4 space-y-1.5'>
      <h3 className='text-muted-foreground'>频道里的其他设备</h3>
      <ul className='divide-y rounded-lg border bg-card'>
        {props.peers.map((p) => (
          <li key={p.id} className='flex items-center gap-3 px-3 py-2.5'>
            <Avatar id={p.id} name={p.name} avatar={p.avatar} size={32} />
            <OverflowText
              text={p.name || '未命名设备'}
              className='min-w-0 flex-1 font-medium'
            />
            <Button
              variant='outline'
              disabled={props.disabled}
              onClick={() => props.add(p)}
            >
              添加
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 头像右下角的在线灯：绿色在线，灰色离线 */
export function Presence(props: {
  online: boolean
  children: ReactNode
  ring?: string
}) {
  return (
    <Tip content={props.online ? '在线' : '离线'}>
      <span className='relative shrink-0'>
        {props.children}
        <span
          aria-label={props.online ? '在线' : '离线'}
          className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ${props.ring ?? 'ring-card'} ${props.online ? 'bg-success' : 'bg-muted-foreground/40'}`}
        />
      </span>
    </Tip>
  )
}

/** 本机算不算在线：Syncthing 在跑，并且没有把所有设备都暂停 */
export function selfOnline(devices: Device[]) {
  const others = devices.filter((d) => !d.me)
  return others.length === 0 || others.some((d) => !d.paused)
}

// 本机排第一，其余在线的在前
export function Devices(props: {
  devices: Device[]
  peers: Peer[]
  pending: PendingDevice[]
  /** 已忽略的设备：只在“已忽略”里出现，从那里恢复，不在“频道里的其他设备”里给添加 */
  ignored: PendingDevice[]
  identity: Identity
  avatarStyle: string
  disabled: boolean
  accept: (d: PendingDevice) => void
  ignore: (d: PendingDevice) => void
  add: (p: Peer) => void
  open: (id: string) => void
  /** 本机的开关：关掉就暂停和所有设备的同步 */
  setOnline: (online: boolean) => void
}) {
  const meOnline = selfOnline(props.devices)
  const others = props.peers.filter(
    (p) =>
      p.syncthingId &&
      !props.devices.some((d) => d.id === p.syncthingId) &&
      !props.pending.some((d) => d.id === p.syncthingId) &&
      !props.ignored.some((d) => d.id === p.syncthingId),
  )
  const sorted = [...props.devices].sort(
    (a, b) =>
      Number(b.me) - Number(a.me) ||
      Number(b.connected) - Number(a.connected) ||
      a.name.localeCompare(b.name),
  )
  return (
    <>
      {props.pending.length > 0 && (
        <Requests
          pending={props.pending}
          peers={props.peers}
          accept={props.accept}
          ignore={props.ignore}
          disabled={props.disabled}
        />
      )}
      <ul className='divide-y rounded-lg border bg-card'>
        {sorted.map((d) => {
          const seen = formatSeen(d.lastSeen)
          const f = face(d, props.peers)
          const sub = d.me
            ? meOnline
              ? '本机'
              : '本机 · 已离线，不和任何设备同步'
            : d.paused
              ? '已暂停'
              : d.connected
                ? connectionKind(d.kind, d.local) || '在线'
                : seen
                  ? `${seen}在线`
                  : '没有连上过'
          return (
            <li
              key={d.id}
              className={`flex items-center gap-3 py-2.5 pl-3 ${d.me ? 'pr-3' : 'cursor-pointer pr-2 hover:bg-muted/40'}`}
              onClick={d.me ? undefined : () => props.open(d.id)}
            >
              <Presence online={d.me ? meOnline : d.connected}>
                {d.me ? (
                  <Avatar
                    id={props.identity.id}
                    name={props.identity.name}
                    avatar={props.avatarStyle}
                    size={32}
                  />
                ) : (
                  <Avatar id={f.id} name={f.name} avatar={f.avatar} size={32} />
                )}
              </Presence>
              <div className='flex min-w-0 flex-1 flex-col'>
                {/* 不标“频道里的设备”：大多数设备都来自频道，标了没信息量，还被当成连接方式；详情顶部有“经频道自动配对” */}
                <OverflowText
                  text={d.me ? props.identity.name : f.name || '未命名设备'}
                  className='font-medium'
                />
                <span className='text-muted-foreground'>{sub}</span>
              </div>
              {d.me ? (
                <Tip
                  content={
                    meOnline
                      ? '关掉就离线，暂停和所有设备的同步'
                      : '打开恢复同步'
                  }
                >
                  <span>
                    <Switch
                      checked={meOnline}
                      disabled={props.disabled}
                      aria-label='本机在线'
                      onCheckedChange={props.setOnline}
                    />
                  </span>
                </Tip>
              ) : (
                <ChevronRight className='size-4 shrink-0 text-muted-foreground' />
              )}
            </li>
          )
        })}
      </ul>
      {others.length > 0 && (
        <Others peers={others} add={props.add} disabled={props.disabled} />
      )}
    </>
  )
}
