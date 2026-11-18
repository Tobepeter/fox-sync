import { useRef, type ComponentProps } from 'react'
import { X } from 'lucide-react'
import { cn } from 'cn'
import { Input } from './ui/input'

export type ClearableInputProps = ComponentProps<typeof Input> & {
  onClear: () => void
  clearLabel?: string
}

// 照 MediaCrawler Studio：有内容且可编辑时，输入框右侧里面出现清空叉号；className 作用于外层
export function ClearableInput({
  className,
  onClear,
  clearLabel = '清空',
  ref,
  ...props
}: ClearableInputProps) {
  const input = useRef<HTMLInputElement | null>(null)
  const clearable =
    !!String(props.value ?? '') && !props.disabled && !props.readOnly
  return (
    <div className={cn('relative min-w-0', className)}>
      <Input
        {...props}
        ref={(el) => {
          input.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        className='pr-8'
      />
      {clearable && (
        <button
          type='button'
          aria-label={clearLabel}
          title={clearLabel}
          className='absolute top-0.5 right-0.5 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none'
          // 按下时不让输入框失焦，避免焦点样式闪动和提前保存
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onClear()
            input.current?.focus()
          }}
        >
          <X className='size-4' aria-hidden='true' />
        </button>
      )}
    </div>
  )
}
