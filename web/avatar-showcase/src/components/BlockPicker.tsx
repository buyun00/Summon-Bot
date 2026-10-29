import { For, createSignal } from 'solid-js'
import BotTile from './BotTile'
import { POSES, SEQUENCE, STATE_BY_ID, type StateId } from '@/bot/states'
import { t } from '@/i18n'

const PALETTE = SEQUENCE.map((id) => STATE_BY_ID.get(id)!)
const WIDTH = 288

export default function BlockPicker(props: {
  shape: string
  color: string
  expression: string
  onPick: (state: StateId) => void
}) {
  let trigger!: HTMLButtonElement
  let panel!: HTMLDivElement
  const [position, setPosition] = createSignal<Record<string, string>>({})
  const [open, setOpen] = createSignal(false)

  function toggle() {
    if (panel.matches(':popover-open')) return panel.hidePopover()
    const rect = trigger.getBoundingClientRect()
    setPosition({
      position: 'fixed',
      top: 'auto',
      right: 'auto',
      left: `${Math.max(8, Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - 8))}px`,
      bottom: `${window.innerHeight - rect.top + 8}px`
    })
    panel.showPopover()
  }

  function pick(state: StateId) {
    props.onPick(state)
    panel.hidePopover()
  }

  return (
    <>
      <button ref={trigger} type="button" class="flex h-full w-full cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-[var(--line)] text-lg leading-none text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)]" aria-label={t('timeline.addAnimation')} aria-haspopup="true" aria-expanded={open() ? 'true' : 'false'} onClick={toggle}>+</button>
      <div ref={panel} popover="auto" onToggle={(event) => setOpen(event.newState === 'open')} class="m-0 w-72 rounded-xl bg-white p-2 shadow-lg ring-1 ring-black/5" style={position()}>
        <div class="grid grid-cols-4 gap-1.5">
          <For each={PALETTE}>
            {(state) => <BotTile label={t(`states.${state.id}`)} selected={false} state={state.id} shape={props.shape} color={props.color} expression={props.expression} frozenAt={POSES[state.id]} onClick={() => pick(state.id)} />}
          </For>
        </div>
      </div>
    </>
  )
}
