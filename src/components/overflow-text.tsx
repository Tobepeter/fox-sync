import { useRef, useState } from 'react'
import { Tip } from './tip'

// 照 TalkMore：只有文字实际被截断时才提示全文；悬停或聚焦时才测量，不在渲染时读布局
export function OverflowText(props: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [full, setFull] = useState<string | null>(null)
  function measure() {
    const el = ref.current
    setFull(el && el.scrollWidth > el.clientWidth ? props.text : null)
  }
  return (
    <Tip
      content={
        full && (
          <span className='block max-h-[60vh] max-w-96 overflow-hidden break-words whitespace-pre-wrap'>
            {full}
          </span>
        )
      }
    >
      <span
        ref={ref}
        className={`min-w-0 truncate ${props.className ?? ''}`}
        onPointerEnter={measure}
        onFocus={measure}
      >
        {props.text}
      </span>
    </Tip>
  )
}
