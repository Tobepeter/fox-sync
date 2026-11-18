import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import { Button } from './ui/button'
import { SheetBody, SheetFooter } from './ui/sheet'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Avatar } from './avatar'
import { Choice } from './choice'
import { DetailHeader, Row, Section } from './folder-detail'
import { Tip } from './tip'
import { face } from '../lib/face'
import { buildIgnores, defaultIgnores } from '../lib/ignores'
import { IgnorePicker } from './ignore-picker'
import { toast } from 'sonner'
import {
  api,
  MOCK_EVENT,
  type Device,
  type FolderRequest,
  type PathInfo,
  type Peer,
  type PendingFolder,
} from '../lib/runtime'

const KINDS = [
  { value: 'sendreceive', label: '双向同步' },
  { value: 'sendonly', label: '仅发送' },
  { value: 'receiveonly', label: '仅接收' },
]

const card = 'divide-y rounded-lg border bg-card'
const basename = (path: string) =>
  path.replace(/\/+$/, '').split('/').pop() ?? ''

// 位置下方的一行提示：只说需要注意的，一次一句，按重要程度取第一条
// 这一行始终占着高度，提示出现、消失时下面的内容不跳
function pathHint(i: PathInfo | null, joining: boolean) {
  if (!i) return null
  if (i.overlap)
    return {
      text: `和已有的文件夹「${i.overlap}」重叠`,
      tone: 'text-destructive',
    }
  if (i.exists && !i.isDir)
    return { text: '这是一个文件，不是目录', tone: 'text-destructive' }
  if (!i.exists)
    return { text: '目录不存在，将自动创建', tone: 'text-muted-foreground' }
  if (joining && i.entries > 0)
    return {
      text: '目录不是空的，会和其他设备的内容合并',
      tone: 'text-amber-600 dark:text-amber-400',
    }
  if (i.hasIgnores)
    return { text: '沿用目录里已有的 .stignore', tone: 'text-muted-foreground' }
  return null
}

function PathHint(props: { info: PathInfo | null; joining: boolean }) {
  const hint = pathHint(props.info, props.joining)
  return <p className={`h-5 truncate px-1 ${hint?.tone ?? ''}`}>{hint?.text}</p>
}

/**
 * 新建或加入文件夹，整页显示（表单项多，不放弹窗）；pending 有值是加入别人共享的
 * 加入时默认放在设置里的存放位置下，用文件夹名当目录名
 */
export function FolderForm(props: {
  pending: PendingFolder | null
  devices: Device[]
  peers: Peer[]
  joinRoot: string
  disabled: boolean
  submit: (request: FolderRequest) => Promise<boolean>
  back: () => void
}) {
  const p = props.pending
  const joining = p !== null
  const others = props.devices.filter((d) => !d.me)
  const [label, setLabel] = useState(p?.label ?? '')
  const [path, setPath] = useState(
    p ? `${props.joinRoot}/${p.label || p.id}` : '',
  )
  const [kind, setKind] = useState('sendreceive')
  const [shared, setShared] = useState<string[]>(
    p ? p.offeredBy : others.map((d) => d.id),
  )
  const [versioning, setVersioning] = useState(true)
  const [autoShare, setAutoShare] = useState(true)
  const [checked, setChecked] = useState(defaultIgnores)
  const [custom, setCustom] = useState('')
  const [info, setInfo] = useState<PathInfo | null>(null)
  const [pending, setPending] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  // 点过“新建”后才把有问题的输入框标红，刚打开时不吓人
  const [touched, setTouched] = useState(false)
  // DEV：Mock 浮窗切了“目录是什么情况”，位置没变也要重新检查
  const [recheck, setRecheck] = useState(0)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onMock = (e: Event) => {
      const { target } = (e as CustomEvent<{ target: string }>).detail
      if (target !== 'dialog' && target !== '') return
      // 位置还空着就填一个示例目录，提示才看得到
      setPath((v) => v || '~/Documents/示例资料')
      setLabel((v) => v || '示例资料')
      setRecheck((n) => n + 1)
    }
    window.addEventListener(MOCK_EVENT, onMock)
    return () => window.removeEventListener(MOCK_EVENT, onMock)
  }, [])

  useEffect(() => {
    if (!path.trim()) return setInfo(null)
    let stale = false
    const timer = setTimeout(
      () =>
        void api
          .inspectPath(path)
          .then((i) => !stale && setInfo(i))
          .catch(() => {}),
      250,
    )
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [path, recheck])

  async function pick() {
    const picked = await api.pickFolder(path || undefined).catch(() => null)
    if (!picked) return
    setPath(picked)
    if (!label.trim()) setLabel(basename(picked))
  }

  async function submit() {
    // 不符合条件时不提交，右上角说明原因，并把有问题的输入框标红
    if (problem) {
      setTouched(true)
      toast.error(problem, { id: 'folder-form' })
      return
    }
    setPending(true)
    try {
      const ok = await props.submit({
        id: p?.id ?? null,
        label,
        path,
        kind,
        devices: autoShare ? [] : shared,
        ignores: info?.hasIgnores ? '' : buildIgnores(checked, custom),
        versioning,
        autoShare,
      })
      if (ok) props.back()
    } finally {
      setPending(false)
    }
  }

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id)
  // 不能提交的原因：名称、位置没填，位置是文件，或和已有文件夹重叠（相同或嵌套）
  const labelProblem = !label.trim() ? '请填写名称' : ''
  const pathProblem = !path.trim()
    ? '请选择或输入位置'
    : info?.overlap
      ? `这个位置和已有的文件夹「${info.overlap}」重叠`
      : info?.exists && !info.isDir
        ? '这个位置是一个文件，不是目录'
        : ''
  const problem = labelProblem || pathProblem
  const from =
    p?.offeredBy.map((id) =>
      face(
        others.find((d) => d.id === id) ?? { id, name: '未知设备' },
        props.peers,
      ),
    ) ?? []
  // 已配对的频道设备：自动共享时都会加进来，以后新配对的也会
  const channelDevices = others.filter((d) =>
    props.peers.some((x) => x.syncthingId === d.id),
  )

  return (
    <>
      <DetailHeader>
        <h2 className='truncate font-medium'>
          {joining ? '加入文件夹' : '新建文件夹'}
        </h2>
        {joining && (
          <span className='flex items-center gap-1.5 text-muted-foreground'>
            来自
            {from.map((d) => (
              <span key={d.id} className='inline-flex items-center gap-1'>
                <Avatar id={d.id} name={d.name} avatar={d.avatar} size={18} />
                {d.name}
              </span>
            ))}
          </span>
        )}
      </DetailHeader>
      <SheetBody className='space-y-5'>
        <Section title='基本'>
          <div className={card}>
            <Row label='名称' help='只在这台电脑上显示'>
              <Input
                className='w-full'
                value={label}
                maxLength={60}
                placeholder='比如：接力资料'
                aria-invalid={touched && !!labelProblem}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Row>
            <Row label='位置'>
              <Input
                className='w-full'
                value={path}
                placeholder='选择或输入目录'
                aria-invalid={
                  (touched && !path.trim()) ||
                  !!info?.overlap ||
                  (!!info?.exists && !info.isDir)
                }
                onChange={(e) => setPath(e.target.value)}
              />
              <Button variant='outline' size='sm' onClick={() => void pick()}>
                <FolderOpen />
                选择
              </Button>
            </Row>
          </div>
          <PathHint info={info} joining={joining} />
        </Section>

        <Section title='同步'>
          <div className={card}>
            <Row label='同步方向' help='仅发送：只发不收；仅接收：只收不发'>
              <Choice
                label='同步方向'
                value={kind}
                options={KINDS}
                onChange={setKind}
              />
            </Row>
            <Row
              label='保留旧版本'
              help='别的设备删除或覆盖的文件保留 30 天，在 .stversions 里'
            >
              <Switch
                checked={versioning}
                onCheckedChange={setVersioning}
                aria-label='保留旧版本'
              />
            </Row>
          </div>
        </Section>

        {/* 不常改的收进“高级”，默认折叠：共享默认给频道里的所有设备，忽略规则用默认模板 */}
        <section className='space-y-3'>
          <Button
            variant='ghost'
            size='sm'
            className='-ml-2 h-auto max-w-full py-1 text-muted-foreground'
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced ? <ChevronDown /> : <ChevronRight />}
            <span className='shrink-0'>高级</span>
          </Button>
          {advanced && (
            <div className='space-y-5'>
              <Section title='共享'>
                <div className={card}>
                  <Row
                    label='频道里的所有设备'
                    help='以后配对的新设备也会自动收到'
                  >
                    {autoShare && channelDevices.length > 0 && (
                      <span className='flex -space-x-1.5'>
                        {channelDevices.map((d) => {
                          const f = face(d, props.peers)
                          return (
                            <Tip key={d.id} content={f.name}>
                              <span className='rounded-full ring-2 ring-card'>
                                <Avatar
                                  id={f.id}
                                  name={f.name}
                                  avatar={f.avatar}
                                  size={22}
                                />
                              </span>
                            </Tip>
                          )
                        })}
                      </span>
                    )}
                    <Switch
                      checked={autoShare}
                      onCheckedChange={setAutoShare}
                      aria-label='共享给频道里的所有设备'
                    />
                  </Row>
                  {!autoShare &&
                    !joining &&
                    others.map((d) => {
                      const f = face(d, props.peers)
                      return (
                        <div
                          key={d.id}
                          className='flex min-h-10 items-center gap-2 px-3 py-1.5'
                        >
                          <Avatar
                            id={f.id}
                            name={f.name}
                            avatar={f.avatar}
                            size={22}
                          />
                          <span
                            className={`flex-1 truncate ${d.connected ? '' : 'text-muted-foreground'}`}
                          >
                            {f.name || '未命名设备'}
                          </span>
                          <Switch
                            checked={shared.includes(d.id)}
                            aria-label={`共享给 ${f.name}`}
                            onCheckedChange={(on) =>
                              setShared((s) => toggle(s, d.id, on))
                            }
                          />
                        </div>
                      )
                    })}
                </div>
              </Section>
              <Section
                title='忽略'
                help='写进目录里的 .stignore，只对这台电脑生效；没勾的留成注释'
              >
                {info?.hasIgnores ? (
                  <p className='px-1 text-muted-foreground'>
                    沿用目录里已有的 .stignore
                  </p>
                ) : (
                  <IgnorePicker
                    checked={checked}
                    setChecked={setChecked}
                    custom={custom}
                    setCustom={setCustom}
                  />
                )}
              </Section>
            </div>
          )}
        </section>
      </SheetBody>
      <SheetFooter>
        <Button variant='outline' disabled={pending} onClick={props.back}>
          取消
        </Button>
        <Button
          disabled={pending || props.disabled}
          aria-busy={pending}
          onClick={() => void submit()}
        >
          {joining ? '加入' : '新建'}
        </Button>
      </SheetFooter>
    </>
  )
}
