import { toast } from 'sonner'
import { Copy, Radio } from 'lucide-react'
import { Button } from './ui/button'
import { SheetBody } from './ui/sheet'
import { Switch } from './ui/switch'
import { Avatar } from './avatar'
import { ConfirmAction } from './confirm-action'
import { OverflowText } from './overflow-text'
import { Tip } from './tip'
import { Presence } from './devices'
import { DetailHeader, InlineText, Row, Section } from './folder-detail'
import { face } from '../lib/face'
import { connectionKind, formatSeen } from '../lib/format'
import { api, type Device, type Folder, type Peer } from '../lib/runtime'

const card = 'divide-y rounded-lg border bg-card'

export function DeviceDetail(props: {
  device: Device
  folders: Folder[]
  peers: Peer[]
  autoShare: string[]
  disabled: boolean
  run: (work: () => Promise<unknown>) => Promise<boolean>
  back: () => void
}) {
  const d = props.device
  const who = face(d, props.peers)
  const seen = formatSeen(d.lastSeen)
  const act = (work: () => Promise<unknown>, done?: string) =>
    void props
      .run(work)
      .then((ok) => ok && done && toast.success(done, { id: 'device-detail' }))
  const status = d.paused
    ? '已暂停'
    : d.connected
      ? connectionKind(d.kind, d.local) || '在线'
      : seen
        ? `${seen}在线`
        : '没有连上过'

  return (
    <>
      <DetailHeader>
        <Presence online={d.connected} ring='ring-background'>
          <Avatar id={who.id} name={who.name} avatar={who.avatar} size={28} />
        </Presence>
        <h2 className='truncate font-medium'>{who.name || '未命名设备'}</h2>
        {who.peer && (
          <Tip content='经频道自动配对'>
            <Radio
              className='size-3.5 shrink-0 text-muted-foreground'
              aria-label='经频道自动配对'
            />
          </Tip>
        )}
      </DetailHeader>
      <SheetBody className='space-y-5'>
        <Section title='设备'>
          <div className={card}>
            <Row label='连接' help='关掉就暂停和这台设备同步'>
              <span className='text-muted-foreground'>{status}</span>
              <Switch
                checked={!d.paused}
                disabled={props.disabled}
                aria-label='连接'
                onCheckedChange={(on) =>
                  act(() => api.updateDevice(d.id, { paused: !on }))
                }
              />
            </Row>
            <Row
              label='名称'
              help={who.peer ? '跟着对方的昵称' : '只改这台电脑上的叫法'}
            >
              {who.peer ? (
                <span className='text-muted-foreground'>{who.name}</span>
              ) : (
                <InlineText
                  value={d.name}
                  disabled={props.disabled}
                  onSave={(name) => act(() => api.updateDevice(d.id, { name }))}
                />
              )}
            </Row>

            {d.clientVersion && (
              <Row label='Syncthing 版本'>
                <span className='text-muted-foreground'>{d.clientVersion}</span>
              </Row>
            )}
            <Row label='设备 ID'>
              <OverflowText
                text={d.id}
                className='font-mono text-xs text-muted-foreground'
              />
              <Tip content='复制'>
                <Button
                  variant='ghost'
                  size='icon-sm'
                  aria-label='复制设备 ID'
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(d.id)
                      .then(() =>
                        toast.success('已复制', { id: 'device-detail' }),
                      )
                  }
                >
                  <Copy />
                </Button>
              </Tip>
            </Row>
          </div>
        </Section>

        <Section title='共享的文件夹'>
          {props.folders.length === 0 ? (
            <p className='px-1 text-muted-foreground'>还没有文件夹</p>
          ) : (
            <div className={card}>
              {props.folders.map((f) => {
                const locked = who.peer && props.autoShare.includes(f.id)
                return (
                  <div
                    key={f.id}
                    className='flex min-h-10 items-center gap-2 px-3 py-1.5'
                  >
                    <span className='flex-1 truncate'>{f.label || f.id}</span>
                    <Tip
                      content={locked ? '这个文件夹自动共享给频道设备' : null}
                    >
                      <span>
                        <Switch
                          checked={f.devices.includes(d.id) || locked}
                          disabled={props.disabled || locked}
                          aria-label={`共享 ${f.label}`}
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
          )}
        </Section>

        <div className='flex justify-end'>
          <ConfirmAction
            label='移除设备'
            description={`从 Syncthing 里移除 ${who.name || '这台设备'}？不再和它同步${who.peer ? '，之后可以在“频道里的其他设备”里加回来' : ''}`}
            success='已移除'
            disabled={props.disabled}
            trigger={
              <Button
                variant='outline'
                className='text-destructive'
                disabled={props.disabled}
              >
                移除设备
              </Button>
            }
            onConfirm={() =>
              props
                .run(() => api.removeDevice(d.id))
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
