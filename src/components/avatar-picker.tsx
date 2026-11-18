import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Avatar } from './avatar'
import { HelpTip } from './help-tip'
import { AVATAR_CREDITS, AVATAR_STYLES, styleLabel } from '../lib/avatar-styles'

const SIZE = 36

const credits = (
  <span>
    头像由 DiceBear 生成。以下风格按 CC BY 4.0 使用：
    {AVATAR_CREDITS.map(([style, author]) => `${style}（${author}）`).join(
      '、',
    )}
  </span>
)

// 点当前头像打开弹窗：8 列一屏放下全部风格，不滚动；点一下即选中并关闭
export function AvatarPicker(props: {
  id: string
  name: string
  value: string
  named: boolean
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  // 打开时聚焦当前选中的头像，避免焦点落到标题旁的问号上把提示弹出来
  const selected = useRef<HTMLButtonElement>(null)
  const options = ['name', ...AVATAR_STYLES]
  return (
    <>
      <button
        aria-label='更换头像'
        disabled={props.disabled}
        onClick={() => setOpen(true)}
        className='rounded-full ring-2 ring-transparent transition-shadow hover:ring-border focus-visible:ring-ring focus-visible:outline-none'
      >
        <Avatar
          id={props.id}
          name={props.name}
          avatar={props.value}
          size={32}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='sm:max-w-fit' initialFocus={selected}>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-0.5'>
              选择头像
              <HelpTip label='头像版权'>{credits}</HelpTip>
            </DialogTitle>
          </DialogHeader>
          <div
            className='grid grid-cols-8 gap-1.5 p-0.5'
            role='radiogroup'
            aria-label='头像'
          >
            {options.map((value) => {
              const off = value === 'name' && !props.named
              const checked = props.value === value
              return (
                <button
                  key={value}
                  ref={checked ? selected : undefined}
                  role='radio'
                  aria-checked={checked}
                  aria-label={value === 'name' ? '名字' : styleLabel(value)}
                  disabled={off}
                  onClick={() => {
                    props.onChange(value)
                    setOpen(false)
                  }}
                  className={`rounded-full p-0.5 ring-2 transition-shadow focus-visible:outline-none disabled:opacity-40 ${checked ? 'ring-primary' : 'ring-transparent enabled:hover:ring-border focus-visible:ring-border'}`}
                >
                  {off ? (
                    <span
                      className='flex items-center justify-center rounded-full border border-dashed text-muted-foreground'
                      style={{ width: SIZE, height: SIZE }}
                    >
                      名
                    </span>
                  ) : (
                    <Avatar
                      id={props.id}
                      name={props.name}
                      avatar={value}
                      size={SIZE}
                    />
                  )}
                </button>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
