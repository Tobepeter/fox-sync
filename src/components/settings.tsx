import { useEffect, useState, type ReactNode } from 'react'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { Choice } from './choice'
import { AvatarPicker } from './avatar-picker'
import { ClearableInput } from './clearable-input'
import { ConfirmAction } from './confirm-action'
import { HelpTip } from './help-tip'
import { FolderOpen } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { cleanName, hasName, NAME_LIMIT } from '../lib/avatar-text'
import {
  api,
  desktop,
  type Settings as SettingsData,
  type Snapshot,
} from '../lib/runtime'

function Row(props: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className='flex min-h-9 items-center justify-between gap-4'>
      <div className='flex items-center gap-0.5'>
        {props.label}
        {props.help && <HelpTip label={props.label}>{props.help}</HelpTip>}
      </div>
      <div className='flex shrink-0 items-center gap-2'>{props.children}</div>
    </div>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-1'>
      <h3 className='text-muted-foreground'>{props.title}</h3>
      {props.children}
    </section>
  )
}

// 失焦或回车保存，Esc 还原；值等于 fallback 时留空、以灰色占位显示，清空即回到 fallback
function TextSetting(props: {
  value: string
  onSave: (value: string) => void
  fallback?: string
  placeholder?: string
  disabled?: boolean
  maxLength?: number
}) {
  const shown =
    props.fallback !== undefined && props.value === props.fallback
      ? ''
      : props.value
  const [value, setValue] = useState(shown)
  useEffect(() => setValue(shown), [shown])
  const commit = (next: string) => {
    const resolved = next.trim() || props.fallback || ''
    if (resolved !== props.value) props.onSave(resolved)
  }
  return (
    <ClearableInput
      className='w-60'
      value={value}
      disabled={props.disabled}
      placeholder={props.fallback ?? props.placeholder}
      maxLength={props.maxLength}
      onChange={(e) => setValue(e.target.value)}
      onClear={() => setValue('')}
      onBlur={() => commit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing)
          (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setValue(shown)
      }}
    />
  )
}

// 只在不正常时说一句；正常连上不占地方
function channelText(snapshot: Snapshot) {
  const c = snapshot.channel
  if (c.state === 'waiting') return c.error || '已断开'
  if (c.state === 'unconfigured') return '未内置频道'
  if (c.state === 'connecting') return '连接中…'
  return ''
}

type PanelProps = {
  snapshot: Snapshot
  disabled: boolean
  set: (patch: Partial<SettingsData>) => void
  run: (work: () => Promise<unknown>) => Promise<boolean>
}

function General({ snapshot, disabled, set, run }: PanelProps) {
  const settings = snapshot.settings
  const named = hasName(snapshot.identity.name)
  return (
    <>
      <Section title='身份'>
        <Row label='昵称' help='清空回到电脑名'>
          <TextSetting
            value={snapshot.identity.name}
            fallback={snapshot.computerName}
            maxLength={NAME_LIMIT}
            disabled={disabled}
            onSave={(name) => void run(() => api.saveIdentity(cleanName(name)))}
          />
        </Row>
        <Row label='头像'>
          <AvatarPicker
            id={snapshot.identity.id}
            name={snapshot.identity.name}
            value={settings.avatarStyle}
            named={named}
            disabled={disabled}
            onChange={(avatarStyle) => set({ avatarStyle })}
          />
        </Row>
      </Section>
      <Section title='频道'>
        <Row
          label='自动添加设备'
          help='频道里发现新设备时自动添加，每台只加一次；关掉后在设备页手动添加'
        >
          {channelText(snapshot) && (
            <span className='text-muted-foreground'>
              {channelText(snapshot)}
            </span>
          )}
          <Switch
            checked={settings.autoAdd}
            disabled={disabled}
            onCheckedChange={(autoAdd) => set({ autoAdd })}
          />
        </Row>
        <Row
          label='自动加入共享的文件夹'
          help='频道里的设备共享来的文件夹直接加入，放在下面的存放位置；关掉后要在“可加入”里手动加入'
        >
          <Switch
            checked={settings.autoJoin}
            disabled={disabled}
            onCheckedChange={(autoJoin) => set({ autoJoin })}
          />
        </Row>
        <Row
          label='存放位置'
          help='自动加入和手动加入时，默认在这里按文件夹名建目录'
        >
          <TextSetting
            value={settings.joinRoot}
            fallback='~/FoxSync'
            disabled={disabled}
            onSave={(joinRoot) => set({ joinRoot })}
          />
          <Button
            variant='outline'
            size='sm'
            disabled={disabled}
            onClick={() =>
              void api
                .pickFolder(settings.joinRoot)
                .then((p) => p && set({ joinRoot: p }))
            }
          >
            <FolderOpen />
            选择
          </Button>
        </Row>
      </Section>
      <Section title='桌面'>
        <Row label='外观'>
          <ThemeToggle
            value={settings.theme}
            disabled={disabled}
            onChange={(theme) => set({ theme })}
          />
        </Row>
        <Row label='Dock 图标'>
          <Choice
            label='Dock 图标'
            value={settings.dockMode}
            options={[
              { value: 'window', label: '窗口打开时' },
              { value: 'always', label: '始终' },
              { value: 'never', label: '不显示' },
            ]}
            onChange={(dockMode) => set({ dockMode })}
            disabled={disabled}
          />
        </Row>
        <Row
          label='登录时启动'
          help={snapshot.dev ? '开发版不注册' : undefined}
        >
          <Switch
            checked={settings.launchAtLogin}
            disabled={disabled || snapshot.dev}
            onCheckedChange={(launchAtLogin) => set({ launchAtLogin })}
          />
        </Row>
      </Section>
    </>
  )
}

// 按钮本身说明用途，不再加行名
function Maintenance({
  disabled,
  run,
  wiped,
}: PanelProps & { wiped: () => void }) {
  return (
    <Section title='维护'>
      <div className='grid grid-cols-4 gap-2 pt-1'>
        <Button
          variant='outline'
          className='w-full'
          disabled={!desktop}
          onClick={() => void run(api.openLogs)}
        >
          调试日志
        </Button>
        <Button
          variant='outline'
          className='w-full'
          disabled={disabled}
          onClick={() => void run(api.refreshSyncthing)}
        >
          重新检查
        </Button>
        <ConfirmAction
          label='重置设置'
          description='恢复默认设置？昵称会保留'
          success='已恢复默认设置'
          disabled={disabled}
          trigger={
            <Button variant='outline' className='w-full' disabled={disabled}>
              重置设置
            </Button>
          }
          onConfirm={() => run(api.resetSettings)}
        />
        <ConfirmAction
          label='清除数据'
          description='删除 FoxSync 的设置、身份、日志和界面里存的状态？Syncthing 的配置和同步的文件不受影响'
          success='已清除全部数据'
          disabled={disabled}
          trigger={
            <Button
              variant='outline'
              className='w-full text-destructive'
              disabled={disabled}
            >
              清除数据
            </Button>
          }
          onConfirm={() =>
            run(api.wipeData).then((ok) => {
              if (ok) wiped()
              return ok
            })
          }
        />
      </div>
    </Section>
  )
}

export function Settings(props: {
  snapshot: Snapshot
  disabled: boolean
  save: (settings: SettingsData) => Promise<boolean>
  run: (work: () => Promise<unknown>) => Promise<boolean>
  /** 清除数据成功后，清掉界面自己存的东西 */
  wiped: () => void
}) {
  const panel: PanelProps = {
    snapshot: props.snapshot,
    disabled: props.disabled,
    run: props.run,
    set: (patch) => void props.save({ ...props.snapshot.settings, ...patch }),
  }
  return (
    <div className='max-w-xl space-y-5 pb-4'>
      <h2 className='font-medium'>设置</h2>
      <General {...panel} />
      <Maintenance {...panel} wiped={props.wiped} />
    </div>
  )
}
