import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Textarea } from './ui/textarea'
import { buildIgnores, IGNORE_ITEMS } from '../lib/ignores'

// 新建 / 加入时选忽略规则：左边列表，右边面板
// 列表里勾选框只管启用，点名称选中查看；右边显示这项为什么建议忽略，以及每条规则加行尾说明（像代码注释）
// 列表最后是“自定义”（右边是输入框）；“预览 .stignore”放在整个面板下面，点开看完整文件
type Pick = string | 'custom'

const row =
  'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/60'

export function IgnorePicker(props: {
  checked: string[]
  setChecked: (next: string[]) => void
  custom: string
  setCustom: (next: string) => void
}) {
  const [pick, setPick] = useState<Pick>(IGNORE_ITEMS[0].id)
  const [preview, setPreview] = useState(false)
  const item = IGNORE_ITEMS.find((i) => i.id === pick)
  const customLines = props.custom.split('\n').filter((l) => l.trim()).length
  const toggle = (id: string, on: boolean) =>
    props.setChecked(
      on ? [...props.checked, id] : props.checked.filter((x) => x !== id),
    )

  return (
    <div className='space-y-2'>
      <div className='grid grid-cols-[10rem_1fr] overflow-hidden rounded-lg border bg-card'>
        <ul className='divide-y border-r'>
          {IGNORE_ITEMS.map((i) => (
            <li key={i.id} className={pick === i.id ? 'bg-muted' : ''}>
              <div className={row} onClick={() => setPick(i.id)}>
                {/* 勾选框和选中分开：点勾选框只改启用，不切换右边 */}
                <span onClick={(e) => e.stopPropagation()} className='flex'>
                  <Checkbox
                    checked={props.checked.includes(i.id)}
                    aria-label={`忽略${i.label}`}
                    onCheckedChange={(on) => toggle(i.id, on)}
                  />
                </span>
                <span className='truncate'>{i.label}</span>
              </div>
            </li>
          ))}
          <li className={pick === 'custom' ? 'bg-muted' : ''}>
            <button
              type='button'
              className={row}
              onClick={() => setPick('custom')}
            >
              <span className='flex-1 truncate'>自定义</span>
              {customLines > 0 && (
                <span className='text-xs text-muted-foreground'>
                  {customLines}
                </span>
              )}
            </button>
          </li>
        </ul>

        <div className='min-h-56 min-w-0 space-y-3 p-3'>
          {item && (
            <>
              <div className='flex items-center justify-between gap-2'>
                <span className='font-medium'>{item.label}</span>
                <span className='text-xs text-muted-foreground'>
                  {props.checked.includes(item.id)
                    ? '已启用'
                    : '未启用，会以注释留在文件里'}
                </span>
              </div>
              <p className='text-muted-foreground'>{item.description}</p>
              <div className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-muted px-3 py-2 font-mono text-xs'>
                {item.lines.map((l) => (
                  <div key={l.rule} className='contents'>
                    <span>{l.rule}</span>
                    <span className='text-muted-foreground'>// {l.note}</span>
                  </div>
                ))}
              </div>
              {item.lines.some((l) => l.rule.startsWith('(?d)')) && (
                <p className='text-xs text-muted-foreground'>
                  (?d)：删除目录时，这些文件可以跟着一起删掉
                </p>
              )}
            </>
          )}
          {pick === 'custom' && (
            <>
              <span className='font-medium'>自定义</span>
              <Textarea
                value={props.custom}
                rows={6}
                className='font-mono text-xs'
                placeholder={'每行一条，比如：\n*.log\n素材/原片'}
                onChange={(e) => props.setCustom(e.target.value)}
              />
              <p className='text-xs text-muted-foreground'>
                注释要整行写 //，写在规则后面会被当成文件名的一部分
              </p>
            </>
          )}
        </div>
      </div>
      <Button
        variant='ghost'
        size='sm'
        className='-ml-2 text-muted-foreground'
        onClick={() => setPreview(!preview)}
      >
        {preview ? <ChevronDown /> : <ChevronRight />}
        预览 .stignore
      </Button>
      {preview && (
        // 不限高：只用抽屉一个滚动条；长行折行，免得出横向滚动
        <pre className='rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]'>
          {buildIgnores(props.checked, props.custom)}
        </pre>
      )}
    </div>
  )
}
