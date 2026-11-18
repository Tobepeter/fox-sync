// 右侧抽屉：照 shadcn 的 Sheet 写法，底层用 Base UI 的 Dialog（和 ui/dialog.tsx 同一个根，沿用它对通知、Mock 浮窗的外部点击处理）
import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { XIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from './button'
import { Dialog } from './dialog'

const Sheet = Dialog

function SheetContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal data-slot='sheet-portal'>
      <DialogPrimitive.Backdrop
        data-slot='sheet-overlay'
        className='fixed inset-0 z-50 bg-black/10 duration-200 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0'
      />
      <DialogPrimitive.Popup
        data-slot='sheet-content'
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background text-sm shadow-lg outline-none data-open:animate-in data-open:slide-in-from-right data-open:duration-300 data-closed:animate-out data-closed:slide-out-to-right data-closed:duration-200',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

/** 抽屉顶部：标题在左，关闭在右；红绿灯那一行留出拖动区 */
function SheetHeader({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-4 py-2.5',
        className,
      )}
    >
      <div className='flex min-w-0 flex-1 items-center gap-2'>{children}</div>
      <DialogPrimitive.Close
        render={<Button variant='ghost' size='icon-sm' aria-label='关闭' />}
      >
        <XIcon />
      </DialogPrimitive.Close>
    </div>
  )
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot='sheet-title'
      className={cn('truncate font-medium', className)}
      {...props}
    />
  )
}

/** 抽屉底部固定的操作栏，正文再长按钮也一直看得见 */
function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sheet-footer'
      className={cn(
        'flex shrink-0 justify-end gap-2 border-t px-4 py-3',
        className,
      )}
      {...props}
    />
  )
}

/**
 * 抽屉正文：夹在固定的顶部和底部之间，占满剩下的高度，自己滚动
 * 始终带着（透明的）滚动条轨道，内容变长时宽度不变；不用 scrollbar-gutter：WebKit 里它预留的宽度和自定义滚动条对不上，会跳几个像素
 */
function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sheet-body'
      className={cn(
        'app-scroll min-h-0 flex-1 overflow-y-scroll p-4',
        className,
      )}
      {...props}
    />
  )
}

export { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle }
