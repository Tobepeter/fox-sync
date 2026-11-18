// DEBUG：Mock 模式的入口，只在开发版、并且调试页里打开了 Mock 模式时出现；全局一个，内容跟着当前页面换
// 右下角一个圆形小图标是唯一的交互点：点一下浮窗从它旁边弹出，再点一下收起；点页面别处不会关
// 拖拽和动画交给 Motion：拖图标时直接改元素位置、不经过 React 渲染，限制在窗口内，拖动和点击自动区分；
// 浮窗是图标的子元素，跟着一起动，不会滞后。上方或左边放不下时浮窗翻到另一侧：拖动中每次移动都算（只读一次位置，方向变了才重新渲染），松手再算一次
// 位置和展开状态只放内存：本次打开期间切页面、进出调试页都保留，刷新后回到默认
// 试过的：Zag 的 floating-panel（照 Figma 窗口设计，双击最大化）；手写拖拽 + Popover（每次移动都重新渲染、浮窗追着图标跑，拖起来发粘）
import { useEffect, useRef, useState } from 'react'
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
} from 'motion/react'
import { toast } from 'sonner'
import { FlaskConical } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { api, mockActive } from '../lib/runtime'
import { MOCK_STATES } from './web/runtime'

const NAMES: Record<string, string> = {
  folders: '文件夹',
  folder: '文件夹详情',
  devices: '设备',
  device: '设备详情',
  settings: '设置',
  dialog: '新建 / 加入',
}

// 浮窗高度随页面的状态数变，展开时量实际高度，这里只是没展开时的估计
const PANEL = { width: 288, height: 220 }
const pressed =
  'data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground'

// 只放内存：组件卸载再挂上（切到调试页再回来）时接着用，刷新页面就回到默认
const memory = { open: true, x: 0, y: 0 }

export function MockBar(props: {
  target: string
  id?: string
  restored: () => Promise<unknown>
}) {
  const [active, setActive] = useState('')
  const [open, setOpenState] = useState(memory.open)
  // 浮窗放在图标的哪一侧：默认上方、右对齐；靠近窗口上边或左边时翻过去
  const [place, setPlace] = useState({ above: true, alignRight: true })
  const bounds = useRef<HTMLDivElement>(null)
  const icon = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const controls = useDragControls()
  const x = useMotionValue(memory.x)
  const y = useMotionValue(memory.y)
  const key = `${props.target}:${props.id ?? ''}`

  const setOpen = (on: boolean) => {
    setOpenState(on)
    memory.open = on
  }

  function replace() {
    const r = icon.current?.getBoundingClientRect()
    if (!r) return
    const height = panel.current?.offsetHeight || PANEL.height
    const above = r.top > height + 16
    const alignRight = r.right > PANEL.width + 16
    // 方向没变就返回原对象，React 跳过渲染，拖动时不会每帧都渲染
    setPlace((p) =>
      p.above === above && p.alignRight === alignRight
        ? p
        : { above, alignRight },
    )
  }

  useEffect(() => {
    replace()
    window.addEventListener('resize', replace)
    return () => window.removeEventListener('resize', replace)
  }, [])

  // 展开、换页面后浮窗高度会变，按实际高度再算一次
  useEffect(replace, [open, key])

  // 换到别的页面或别的对象就回到原本的数据，状态只属于当前页面
  useEffect(() => {
    setActive('')
    return () => {
      if (mockActive()) void api.debugRestore().then(props.restored)
    }
  }, [key])

  async function pick(state: string) {
    try {
      if (state) await api.debugMock(props.target, state, props.id)
      else if (mockActive()) {
        await api.debugRestore()
        await props.restored()
      }
      setActive(state)
    } catch (e) {
      toast.error(String(e), { id: 'mock' })
    }
  }

  const states = MOCK_STATES[props.target] ?? []
  return (
    // 比窗口四周各小 8px 的透明层当拖动边界，图标不会贴死在窗口边上；本身不接收点击
    <div ref={bounds} className='pointer-events-none fixed inset-2 z-[60]'>
      <motion.div
        drag
        dragListener={false}
        dragControls={controls}
        dragConstraints={bounds}
        dragMomentum={false}
        dragElastic={0}
        style={{ x, y }}
        // 默认在右下角偏上一点，让出抽屉底部固定的按钮栏
        className='pointer-events-auto absolute right-2 bottom-16'
        onDragStart={() => (dragging.current = true)}
        onDrag={replace}
        onDragEnd={() => {
          memory.x = x.get()
          memory.y = y.get()
          replace()
          // 松手后紧跟着的那次点击不算
          requestAnimationFrame(() => (dragging.current = false))
        }}
      >
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panel}
              data-mock-bar
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              style={{
                width: PANEL.width,
                originX: place.alignRight ? 1 : 0,
                originY: place.above ? 1 : 0,
              }}
              className={`absolute flex flex-col gap-2 rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 ${place.above ? 'bottom-full mb-2' : 'top-full mt-2'} ${place.alignRight ? 'right-0' : 'left-0'}`}
            >
              <span className='px-1 text-xs text-amber-600 dark:text-amber-400'>
                Mock · {NAMES[props.target] ?? props.target}
              </span>
              {states.length === 0 ? (
                <p className='px-1 text-xs text-muted-foreground'>
                  这个页面没有可模拟的状态
                </p>
              ) : (
                <ToggleGroup
                  value={[active]}
                  onValueChange={([next]) => void pick(next ?? '')}
                  variant='outline'
                  size='sm'
                  spacing={1}
                  className='w-full flex-wrap'
                  aria-label='模拟状态'
                >
                  {[{ id: '', label: '原样' }, ...states].map((s) => (
                    <ToggleGroupItem
                      key={s.id || 'original'}
                      value={s.id}
                      className={pressed}
                    >
                      {s.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <button
          ref={icon}
          type='button'
          data-mock-bar
          aria-label={open ? '收起 Mock' : '展开 Mock'}
          aria-expanded={open}
          className={`flex size-9 cursor-grab touch-none items-center justify-center rounded-full border shadow-lg transition-colors active:cursor-grabbing [&_svg]:size-4 ${active ? 'border-amber-500 bg-amber-500 text-white' : 'border-amber-500/60 bg-popover text-amber-600 hover:bg-muted dark:text-amber-400'}`}
          onPointerDown={(e) => controls.start(e)}
          onClick={() => !dragging.current && setOpen(!open)}
        >
          <FlaskConical />
        </button>
      </motion.div>
    </div>
  )
}
