import type { JSX } from '@solidjs/web'
import BloubBot from './BloubBot'
import { DEFAULT_EXPRESSION } from '@/bot/expressions'
import { DEFAULT_COLOR, DEFAULT_SHAPE } from '@/bot/skins'
import type { StateId } from '@/bot/states'

export interface BotTileProps {
  label: string
  selected: boolean
  frozenAt: number
  state?: StateId
  shape?: string
  color?: string
  expression?: string
  size?: number
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
}

export default function BotTile(props: BotTileProps) {
  return (
    <button
      type="button"
      class={`flex cursor-pointer flex-col items-center rounded-xl border-2 p-1 transition ${
        props.selected ? 'border-[var(--ink)]' : 'border-transparent hover:border-[var(--line)]'
      }`}
      aria-label={props.label}
      aria-pressed={props.selected ? 'true' : 'false'}
      onClick={props.onClick}
    >
      <BloubBot
        state={props.state ?? 'idle'}
        size={props.size ?? 60}
        shape={props.shape ?? DEFAULT_SHAPE}
        color={props.color ?? DEFAULT_COLOR}
        expression={props.expression ?? DEFAULT_EXPRESSION}
        frozenAt={props.frozenAt}
        ariaLabel={props.label}
      />
      <span class="text-center text-xs leading-tight text-[var(--muted)]">{props.label}</span>
    </button>
  )
}
