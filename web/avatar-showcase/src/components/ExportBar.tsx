import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { t } from '@/i18n'
import { copiePossible } from '@/ui/capture'
import { ACTIONS, ACTION_DEFAUT, type ActionId, type EtatExport } from '@/ui/export'

export default function ExportBar(props: { etat: EtatExport; onExport: (id: ActionId) => void; class?: string }) {
  const [open, setOpen] = createSignal(false)
  let root!: HTMLDivElement
  const actions = ACTIONS.filter((action) => action.mode !== 'copieImage' || copiePossible())
  const busy = () => props.etat === 'occupe'
  const confirmed = () => props.etat === 'exporte' || props.etat === 'copie'
  const label = createMemo(() => {
    if (props.etat === 'exporte') return t('export.done')
    if (props.etat === 'copie') return t('export.copied')
    if (props.etat === 'erreur') return t('export.failed')
    return t('export.action')
  })
  const outside = (event: PointerEvent) => {
    if (!root.contains(event.target as Node)) setOpen(false)
  }
  createEffect(open, (opened) => opened ? window.addEventListener('pointerdown', outside) : window.removeEventListener('pointerdown', outside))
  onCleanup(() => window.removeEventListener('pointerdown', outside))

  function launch(id: ActionId) {
    setOpen(false)
    props.onExport(id)
  }

  const Download = (iconProps: { size: number }) => (
    <svg width={iconProps.size} height={iconProps.size} viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M3 15C3 17.8284 3 19.2426 3.87868 20.1213C4.75736 21 6.17157 21 9 21H15C17.8284 21 19.2426 21 20.1213 20.1213C21 19.2426 21 17.8284 21 15" /><path d="M12 3V16M8 11.625L12 16L16 11.625" /></g></svg>
  )

  return (
    <div ref={root} class={`${props.class ?? ''} relative`} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <div class={`flex overflow-hidden rounded-xl bg-[var(--ink)] text-[var(--paper)] shadow-sm transition ${busy() ? 'opacity-60' : ''}`}>
        <button type="button" class="flex cursor-pointer items-center gap-2 py-2.5 pr-3 pl-3.5 text-sm font-medium transition hover:bg-white/10 disabled:cursor-default" disabled={busy()} onClick={() => launch(ACTION_DEFAUT)}>
          <Show when={confirmed()} fallback={<Download size={17} />}><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10" /><path stroke-linecap="round" stroke-linejoin="round" d="M8.5 12.5L10.5 14.5L15.5 9.5" /></g></svg></Show>
          {label()}
        </button>
        <div class="w-px self-stretch bg-current opacity-25" />
        <button type="button" class="flex cursor-pointer items-center px-2.5 transition hover:bg-white/10 disabled:cursor-default" disabled={busy()} aria-label={t('export.more')} aria-haspopup="true" aria-expanded={open() ? 'true' : 'false'} onClick={() => setOpen(!open())}>
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" class={`transition-transform ${open() ? 'rotate-180' : ''}`}><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 9L12 15L5 9" /></svg>
        </button>
      </div>
      <Show when={open()}>
        <div class="absolute right-0 bottom-full z-10 mb-2 w-60 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-1 shadow-lg">
          <For each={actions}>
            {(action) => (
              <button type="button" class={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-black/5 ${action.id === 'copie' ? 'mt-1 border-t border-[var(--line)] pt-2.5' : ''}`} onClick={() => launch(action.id)}>
                <span class="shrink-0 text-[var(--muted)]"><Show when={action.mode === 'copieImage' || action.mode === 'copieTexte'} fallback={<Download size={16} />}><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 11C6 8.17157 6 6.75736 6.87868 5.87868C7.75736 5 9.17157 5 12 5H15C17.8284 5 19.2426 5.87868 20.1213 5.87868C21 6.75736 21 8.17157 21 11V16C21 18.8284 21 20.2426 20.1213 21.1213C19.2426 22 17.8284 22 15 22H12C9.17157 22 7.75736 22 6.87868 21.1213C6 20.2426 6 18.8284 6 16V11Z" /><path d="M6 19C4.34315 19 3 17.6569 3 16V10C3 6.22876 3 4.34315 4.17157 3.17157C5.34315 2 7.22876 2 11 2H15C16.6569 2 18 3.34315 18 5" /></g></svg></Show></span>
                {t(`export.${action.id}`)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
