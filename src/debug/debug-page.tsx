// DEBUG：侧栏的“调试”页，照 FoxNudge 放在侧栏
// Mock 模式的开关在这里；另有真实 Syncthing 的几种异常状态模拟、快捷打开和实时探针快照
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Switch } from '../components/ui/switch'
import { HelpTip } from '../components/help-tip'
import {
  api,
  type PendingFolder,
  type SimulateState,
  type Snapshot,
} from '../lib/runtime'

const STATES: { value: SimulateState; label: string }[] = [
  { value: '', label: '正常' },
  { value: 'starting', label: '启动中' },
  { value: 'occupied', label: '被占用' },
  { value: 'failed', label: '起不来' },
  { value: 'stopped', label: '连不上' },
  { value: 'error', label: '出错' },
]

function Group(props: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-1.5'>
      <h3 className='text-muted-foreground'>{props.title}</h3>
      <div className='flex flex-wrap gap-1.5'>{props.children}</div>
    </section>
  )
}

export function DebugPage(props: {
  snapshot: Snapshot
  mockBar: boolean
  setMockBar: (on: boolean) => void
  navigate: (page: string) => void
  openDialog: (joining: PendingFolder | null) => void
  openDetail: (kind: 'folder' | 'device', id: string) => void
}) {
  const [probe, setProbe] = useState<unknown>(null)
  useEffect(() => {
    const refresh = () => {
      const app = window.__DEBUG__?.sync?.app as
        { snapshot: () => unknown } | undefined
      setProbe(app ? app.snapshot() : null)
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => clearInterval(timer)
  }, [])
  const s = props.snapshot.syncthing
  const firstFolder = s.folders[0]
  const firstDevice = s.devices.find((d) => !d.me)
  const run = (work: () => Promise<unknown>) =>
    void work().catch((e) => toast.error(String(e), { id: 'debug' }))
  return (
    <section className='flex max-w-2xl flex-col gap-5 pb-6'>
      <h2 className='font-medium text-amber-600 dark:text-amber-400'>调试</h2>
      <label className='flex items-center justify-between rounded-lg border bg-card px-3 py-2.5'>
        <span className='flex items-center gap-0.5'>
          Mock 模式
          <HelpTip label='Mock 模式'>
            各页面右下角出现状态下拉框，选“原样”恢复；不碰真实 Syncthing
          </HelpTip>
        </span>
        <Switch checked={props.mockBar} onCheckedChange={props.setMockBar} />
      </label>
      <Group title='Syncthing 状态'>
        {STATES.map((x) => (
          <Button
            key={x.value}
            size='sm'
            variant={(x.value || 'ok') === s.state ? 'secondary' : 'outline'}
            onClick={() => run(() => api.debugSimulate(x.value))}
          >
            {x.label}
          </Button>
        ))}
      </Group>
      <Group title='打开'>
        <Button
          size='sm'
          variant='outline'
          onClick={() => props.openDialog(null)}
        >
          新建文件夹
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={!firstFolder}
          onClick={() =>
            firstFolder && props.openDetail('folder', firstFolder.id)
          }
        >
          文件夹详情
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={!firstDevice}
          onClick={() =>
            firstDevice && props.openDetail('device', firstDevice.id)
          }
        >
          设备详情
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => props.navigate('settings')}
        >
          设置
        </Button>
      </Group>
      <section className='space-y-1.5'>
        <h3 className='text-muted-foreground'>探针快照</h3>
        <pre className='max-h-96 overflow-auto rounded-lg border bg-card p-3 text-xs'>
          {JSON.stringify(probe, null, 2)}
        </pre>
      </section>
    </section>
  )
}
