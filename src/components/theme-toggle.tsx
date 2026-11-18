import { Monitor, Moon, Sun } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const themeOptions = [
  { icon: Monitor, label: '跟随系统', value: 'system' },
  { icon: Sun, label: '浅色', value: 'light' },
  { icon: Moon, label: '深色', value: 'dark' },
]

// 参考 FoxMeter 的三段图标选择，保留系统模式本身的选中状态
export type ThemeToggleProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}
export function ThemeToggle(props: ThemeToggleProps) {
  return (
    <ToggleGroup
      disabled={props.disabled}
      value={[props.value]}
      onValueChange={([value]) => value && props.onChange(value)}
      variant='outline'
      size='sm'
      spacing={0}
      aria-label='颜色模式'
    >
      {themeOptions.map(({ icon: Icon, label, value }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className='w-8 data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground'
        >
          <Icon aria-hidden='true' />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
