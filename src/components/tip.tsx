import type { ReactElement, ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { TooltipContent, TooltipTrigger } from './ui/tooltip'

// 全局只挂一个提示层，触发元素经 handle 共享，长列表不再每行创建定位器
const handle = TooltipPrimitive.createHandle<ReactNode>()

export function TipHost() {
  return (
    <TooltipPrimitive.Root handle={handle}>
      {/* 没有内容时不渲染，供“只在文字被截断时提示全文”这类按需提示使用 */}
      {({ payload }) =>
        payload ? <TooltipContent>{payload}</TooltipContent> : null
      }
    </TooltipPrimitive.Root>
  )
}

export function Tip(props: { content: ReactNode; children: ReactElement }) {
  return (
    <TooltipTrigger
      handle={handle}
      payload={props.content}
      render={props.children}
    />
  )
}
