import { useEffect, useRef, useState } from 'react'
import { EyeOff, FolderOpen } from 'lucide-react'
import { Button } from './ui/button'
import { Choice } from './choice'
import { HelpTip } from './help-tip'
import { OverflowText } from './overflow-text'
import { Tip } from './tip'
import { formatBytes } from '../lib/format'
import { offerUndo } from '../lib/undo'
import { api, type Folder, type LargeFiles as Result } from '../lib/runtime'

// 文件夹抽屉里的“大文件”：默认收起，展开才去读；数据是 Syncthing 的文件索引，后端按序号缓存，
// 这里只在文件夹的大小或项数变了时重新取（序号没变后端直接返回缓存，很便宜）
// 档位固定 1 MB / 10 MB / 100 MB / 1 GB，放在标题右侧的下拉里；默认选有结果的最大一档，免得一打开就是一长串
// 每行文件名在上、所在目录在下，大小靠右；操作悬停才出现，和文件夹列表一样
const PAGE = 10
const short = (bytes: number) => formatBytes(bytes).replace('.0', '')

function split(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0
    ? { name: path, dir: '' }
    : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

export function LargeFiles(props: {
  folder: Folder
  disabled: boolean
  /** 忽略规则有没保存的改动时不让加，免得两边互相覆盖 */
  ignoreBlocked: boolean
  /** added：新加了一行；kept：规则里本来就有；null：失败 */
  ignore: (path: string) => Promise<'added' | 'kept' | null>
  /** 撤销：删掉这个文件那一行 */
  unignore: (path: string) => Promise<boolean>
  reveal: (path: string) => void
}) {
  const f = props.folder
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [slow, setSlow] = useState(false)
  const [tier, setTier] = useState<number | null>(null)
  const [shown, setShown] = useState(PAGE)
  // 刚加入忽略的：Syncthing 重扫完才会标成已忽略，这期间先藏起来
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [reload, setReload] = useState(0)
  const folderId = useRef(f.id)
  const idle = f.state === 'idle'

  // 换了文件夹就从头来
  useEffect(() => {
    if (folderId.current === f.id) return
    folderId.current = f.id
    setData(null)
    setTier(null)
    setShown(PAGE)
    setHidden(new Set())
  }, [f.id])

  useEffect(() => {
    if (!open) return
    let stale = false
    // 超过 300 毫秒才显示“正在统计”，快的时候不闪
    const timer = setTimeout(() => setSlow(true), 300)
    void api
      .largeFiles(f.id)
      .then((r) => {
        if (stale) return
        setData(r)
        setError('')
      })
      .catch((e) => !stale && setError(String(e)))
      .finally(() => {
        clearTimeout(timer)
        if (!stale) setSlow(false)
      })
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // 内容变了、或者扫描结束回到空闲（比如加了忽略后重扫完）才重取
  }, [open, f.id, f.globalBytes, f.globalItems, f.localBytes, idle, reload])

  const show = (path: string, on: boolean) =>
    setHidden((h) => {
      const next = new Set(h)
      if (on) next.delete(path)
      else next.add(path)
      return next
    })
  async function ignore(path: string, name: string) {
    const result = await props.ignore(path)
    if (!result) return
    show(path, false)
    // 规则里本来就有这一行的话，撤销会删掉原有规则，不给
    if (result === 'added')
      offerUndo(`已忽略「${name}」`, () =>
        props.unignore(path).then((ok) => {
          if (!ok) return
          show(path, true)
          // 期间可能已经按新规则重取过、列表里没有它了；规则删掉后马上再取一次，不用等重扫
          setReload((n) => n + 1)
        }),
      )
  }

  const gone = (data?.files ?? []).filter((x) => hidden.has(x.path))
  const tiers = (data?.tiers ?? []).map((t) => {
    const out = gone.filter((x) => x.size >= t.min)
    return {
      ...t,
      count: t.count - out.length,
      bytes: t.bytes - out.reduce((n, x) => n + x.size, 0),
    }
  })
  const fallback =
    [...tiers].reverse().find((t) => t.count > 0)?.min ?? tiers[0]?.min
  const current =
    tiers.find((t) => t.min === tier) ?? tiers.find((t) => t.min === fallback)
  const files = (data?.files ?? []).filter(
    (x) => current && x.size >= current.min && !hidden.has(x.path),
  )
  // 一个 1 MB 以上的都没有时，下拉没有意义
  const none = tiers.length > 0 && tiers[0].count === 0
  const more = Math.min(files.length - shown, PAGE * 5)

  return (
    <section className='space-y-1.5'>
      <div className='flex min-h-7 items-center justify-between gap-2'>
        <h3 className='flex items-center gap-0.5 text-muted-foreground'>
          大文件
          <HelpTip label='大文件'>
            按 Syncthing 的文件索引统计，只算参与同步的文件
          </HelpTip>
        </h3>
        <div className='flex items-center gap-1'>
          {open && current && !none && (
            <Choice
              label='大小档位'
              size='sm'
              value={String(current.min)}
              options={tiers.map((t) => ({
                value: String(t.min),
                label: `≥ ${short(t.min)} · ${t.count} 个`,
              }))}
              onChange={(next) => {
                setTier(Number(next))
                setShown(PAGE)
              }}
            />
          )}
          <Button variant='ghost' size='sm' onClick={() => setOpen(!open)}>
            {open ? '收起' : '查看'}
          </Button>
        </div>
      </div>
      {open &&
        (error ? (
          <p className='px-1 text-destructive'>{error}</p>
        ) : !data ? (
          slow && <p className='px-1 text-muted-foreground'>正在统计…</p>
        ) : !current || current.count === 0 ? (
          <p className='px-1 text-muted-foreground'>
            没有 {short(current?.min ?? 1 << 20)} 以上的文件
          </p>
        ) : (
          <div className='divide-y rounded-lg border bg-card'>
            <ul className='divide-y'>
              {files.slice(0, shown).map((x) => {
                const { name, dir } = split(x.path)
                return (
                  <li
                    key={x.path}
                    className='group flex min-h-10 items-center gap-2 py-1.5 pr-3 pl-3 hover:bg-muted/40'
                  >
                    <div className='flex min-w-0 flex-1 flex-col'>
                      <OverflowText text={name} />
                      {dir && (
                        <OverflowText
                          text={dir}
                          className='text-muted-foreground'
                        />
                      )}
                    </div>
                    {/* 悬停才出现，键盘聚焦时也出现 */}
                    <span className='flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'>
                      <Tip content='在访达中显示'>
                        <Button
                          variant='ghost'
                          size='icon-sm'
                          aria-label='在访达中显示'
                          onClick={() => props.reveal(`${f.path}/${x.path}`)}
                        >
                          <FolderOpen />
                        </Button>
                      </Tip>
                      <Tip
                        content={
                          props.ignoreBlocked
                            ? '忽略规则有没保存的改动，先保存或还原'
                            : '忽略：写进 .stignore，这台电脑不再同步它'
                        }
                      >
                        <span>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label='忽略'
                            disabled={props.disabled || props.ignoreBlocked}
                            onClick={() => void ignore(x.path, name)}
                          >
                            <EyeOff />
                          </Button>
                        </span>
                      </Tip>
                    </span>
                    <span className='w-16 shrink-0 text-right text-muted-foreground tabular-nums'>
                      {formatBytes(x.size)}
                    </span>
                  </li>
                )
              })}
            </ul>
            <div className='flex min-h-9 items-center justify-between gap-2 py-1 pr-1.5 pl-3 text-muted-foreground'>
              <span className='tabular-nums'>
                共 {current.count} 个，{formatBytes(current.bytes)}
                {current.count > data.files.length &&
                  `，只列出最大的 ${data.files.length} 个`}
              </span>
              {more > 0 && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground'
                  onClick={() => setShown(shown + PAGE * 5)}
                >
                  再显示 {more} 个
                </Button>
              )}
            </div>
          </div>
        ))}
    </section>
  )
}
