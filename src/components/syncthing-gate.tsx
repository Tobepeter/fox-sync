import type { ReactNode } from 'react'
import {
  ArrowRightLeft,
  CircleAlert,
  LoaderCircle,
  Lock,
  Play,
  RotateCw,
} from 'lucide-react'
import { Button } from './ui/button'
import type { Occupant, Syncthing } from '../lib/runtime'

type Action = {
  label: string
  icon: ReactNode
  onClick: () => void
  primary?: boolean
}

export type GateApi = {
  launch: () => Promise<unknown>
  refresh: () => Promise<unknown>
  takeOver: () => Promise<unknown>
}

// 谁锁着同一份同步配置；Syncthing.app 只在菜单栏有图标，不容易看到，所以写明在菜单栏
const occupantText: Record<string, string> = {
  app: '同步配置被 Syncthing.app 锁住了',
  brew: '同步配置被 brew 的 Syncthing 锁住了',
  other: '同步配置被另一个 Syncthing 锁住了',
}

const occupantWhere: Record<string, string> = {
  app: '它在菜单栏里运行。',
  brew: '它在后台作为 brew 服务运行。',
}

// 同一套配置同时只能跑一个 Syncthing：认得出的（Syncthing.app、brew）可以一键接管，认不出的请用户自己关
function occupiedView(
  o: Occupant | null,
  api: GateApi,
  run: (work: () => Promise<unknown>) => Promise<boolean>,
  retry: Action,
) {
  const kind = o?.kind ?? 'other'
  if (kind === 'other') {
    return {
      icon: <Lock />,
      title: occupantText.other,
      text: `同一份配置同时只能有一个 Syncthing 在用，请先关掉它：${o?.path ?? '未知程序'}`,
      actions: [{ ...retry, primary: true }],
    }
  }
  return {
    icon: <Lock />,
    title: occupantText[kind],
    text: `${occupantWhere[kind] ?? ''}同一份配置同时只能有一个 Syncthing 在用，退出它后由 FoxSync 接着用，已有的设备和文件夹照旧`,
    actions: [
      {
        label:
          kind === 'app'
            ? '退出它，由 FoxSync 运行'
            : '停掉它，由 FoxSync 运行',
        icon: <ArrowRightLeft />,
        onClick: () => void run(api.takeOver),
        primary: true,
      },
    ],
  }
}

// Syncthing 不可用时整页提示：被占用、启动中、起不来、连不上、其他错误
export function SyncthingGate(props: {
  syncthing: Syncthing
  disabled: boolean
  run: (work: () => Promise<unknown>) => Promise<boolean>
  api: GateApi
}) {
  const { syncthing: s, run, api } = props
  const retry: Action = {
    label: '重新检查',
    icon: <RotateCw />,
    onClick: () => void run(api.refresh),
  }
  const restart: Action = {
    label: '重新启动',
    icon: <Play />,
    onClick: () => void run(api.launch),
    primary: true,
  }
  const view: {
    icon: ReactNode
    title: string
    text: string
    actions: Action[]
    tail?: string[]
  } = (() => {
    switch (s.state) {
      case 'occupied':
        return occupiedView(s.daemon.occupant, api, run, retry)
      case 'starting':
        return {
          icon: <LoaderCircle className='animate-spin' />,
          title: '正在启动 Syncthing…',
          text: '',
          actions: [],
        }
      case 'failed':
        return {
          icon: <CircleAlert />,
          title: 'Syncthing 起不来',
          text: s.daemon.error || s.error,
          tail: s.daemon.tail,
          actions: [restart],
        }
      case 'stopped':
        return {
          icon: <CircleAlert />,
          title: '连不上 Syncthing',
          text: '',
          actions: [restart, retry],
        }
      case 'error':
        return {
          icon: <CircleAlert />,
          title: 'Syncthing 出错了',
          text: s.error,
          actions: [retry],
        }
      default:
        return {
          icon: <LoaderCircle className='animate-spin' />,
          title: '正在连接 Syncthing…',
          text: '',
          actions: [],
        }
    }
  })()
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 pb-12 text-center'>
      <div className='text-muted-foreground [&_svg]:size-8'>{view.icon}</div>
      <h2 className='font-medium'>{view.title}</h2>
      {view.text && (
        <p className='max-w-sm text-muted-foreground'>{view.text}</p>
      )}
      {view.tail && view.tail.length > 0 && (
        <pre className='max-h-40 w-full max-w-md overflow-auto rounded-lg bg-muted p-3 text-left text-xs'>
          {view.tail.join('\n')}
        </pre>
      )}
      {view.actions.length > 0 && (
        <div className='mt-2 flex flex-wrap justify-center gap-2'>
          {view.actions.map((a) => (
            <Button
              key={a.label}
              variant={a.primary ? 'default' : 'outline'}
              disabled={props.disabled}
              onClick={a.onClick}
            >
              {a.icon}
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
