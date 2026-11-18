import { RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Tip } from './tip'
import type { Channel } from '../lib/runtime'

// 照 FoxNudge 的连接状态：圆点加固定的两三个字，不显示倒计时免得文字跳动；详情放在悬停提示里
const text: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  waiting: '未连接',
  unconfigured: '未配置',
}

const dot: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-amber-500 animate-pulse',
  waiting: 'bg-destructive',
  unconfigured: 'bg-muted-foreground',
}

function tip(c: Channel, peers: number) {
  switch (c.state) {
    case 'connected':
      return peers
        ? `频道 ${c.topic} · 频道里有 ${peers} 台其他设备`
        : `频道 ${c.topic}`
    case 'waiting':
      return `${c.error || '连接断开'}，会自动重试`
    case 'unconfigured':
      return '这个版本没有内置频道，只能手动配对'
    default:
      return '正在连接频道'
  }
}

export function ChannelStatus(props: {
  channel: Channel
  peers: number
  onReconnect: () => void
}) {
  const c = props.channel
  return (
    <div className='flex items-center gap-1'>
      <Tip content={tip(c, props.peers)}>
        <span className='flex items-center gap-2 text-muted-foreground'>
          <span
            className={`size-2 shrink-0 rounded-full ${dot[c.state] ?? dot.waiting}`}
          />
          {text[c.state] ?? text.waiting}
        </span>
      </Tip>
      {c.state === 'waiting' && (
        <Tip content='立即重连'>
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label='立即重连'
            onClick={props.onReconnect}
          >
            <RefreshCw />
          </Button>
        </Tip>
      )}
    </div>
  )
}
