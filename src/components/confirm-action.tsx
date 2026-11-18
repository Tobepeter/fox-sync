import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tip } from './tip'

export type ConfirmActionProps = {
  label: string
  description: string
  disabled?: boolean
  // 自定义触发元素，例如悬停才出现的图标按钮
  trigger?: ReactElement
  // 图标按钮，名称改为悬停提示；ghost 用于弹窗标题栏这类轻量位置
  icon?: ReactNode
  ghost?: boolean
  // 成功后右上角提示的结果
  success?: string
  onConfirm: () => Promise<boolean>
}

// 清空与重置共用就地确认，成功后关闭并提示
export function ConfirmAction(props: ConfirmActionProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const running = useRef(false)
  async function confirm() {
    if (running.current || props.disabled) return
    running.current = true
    setPending(true)
    try {
      if (!(await props.onConfirm())) return
      setOpen(false)
      if (props.success) toast.success(props.success, { id: 'confirm-action' })
    } finally {
      running.current = false
      setPending(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {props.icon ? (
        <Tip content={props.label}>
          <PopoverTrigger
            render={
              <Button
                variant={props.ghost ? 'ghost' : 'outline'}
                size={props.ghost ? 'icon-sm' : 'icon'}
                aria-label={props.label}
                disabled={props.disabled || pending}
              />
            }
          >
            {props.icon}
          </PopoverTrigger>
        </Tip>
      ) : (
        <PopoverTrigger
          render={
            props.trigger ?? (
              <Button variant='outline' disabled={props.disabled || pending}>
                {props.label}
              </Button>
            )
          }
        />
      )}
      <PopoverContent
        align='end'
        className='space-y-3'
        aria-label={props.label}
      >
        <p>{props.description}</p>
        <div className='flex justify-end gap-2'>
          <Button
            variant='outline'
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            variant='destructive'
            disabled={props.disabled || pending}
            aria-busy={pending}
            onClick={() => void confirm()}
          >
            确认
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
