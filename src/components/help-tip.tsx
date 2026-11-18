import { CircleHelp } from 'lucide-react'
import type { PropsWithChildren } from 'react'
import { Button } from './ui/button'
import { Tip } from './tip'

export function HelpTip(props: PropsWithChildren<{ label: string }>) {
  return (
    <Tip content={props.children}>
      <Button variant='ghost' size='icon-xs' aria-label={props.label}>
        <CircleHelp className='text-muted-foreground' />
      </Button>
    </Tip>
  )
}
