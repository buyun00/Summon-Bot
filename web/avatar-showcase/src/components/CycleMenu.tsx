import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { MAX_CYCLES, type Cycle } from '@/bot/cycles'
import { nomDeCycle, t } from '@/i18n'

export default function CycleMenu(props: {
  cycles: Cycle[]
  current: Cycle
  activeId: string
  onActiveIdChange: (id: string) => void
  onCreate: () => void
  onRemove: (id: string) => void
  onRename: (id: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [page, setPage] = createSignal(0)
  const first = () => Math.min(page(), Math.max(0, Math.ceil(props.cycles.length / MAX_CYCLES) - 1)) * MAX_CYCLES
  const last = () => Math.min(first() + MAX_CYCLES, props.cycles.length)
  const visible = createMemo(() => props.cycles.slice(first(), last()))
  const canCreate = () => props.cycles.length < MAX_CYCLES
  let root!: HTMLDivElement
  let list!: HTMLDivElement
  const outside = (event: PointerEvent) => {
    if (!root.contains(event.target as Node)) setOpen(false)
  }
  createEffect(open, (opened) => opened ? window.addEventListener('pointerdown', outside) : window.removeEventListener('pointerdown', outside))
  onCleanup(() => window.removeEventListener('pointerdown', outside))

  function toggle() {
    if (!open()) {
      const index = props.cycles.findIndex((cycle) => cycle.id === props.activeId)
      setPage(Math.floor(Math.max(0, index) / MAX_CYCLES))
    }
    setOpen(!open())
  }

  function turnPage(direction: number) {
    setPage(first() / MAX_CYCLES + direction)
    list.scrollTop = 0
  }

  return (
    <div ref={root} class="relative min-w-0" onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button type="button" class="flex min-w-0 max-w-56 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm font-medium transition hover:bg-black/5" aria-haspopup="true" aria-expanded={open() ? 'true' : 'false'} title={nomDeCycle(props.current)} onClick={toggle}>
        <span class="tronque">{nomDeCycle(props.current)}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" class="shrink-0 text-[var(--muted)]"><path d="M2 3.5 5 6.5l3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <Show when={open()}>
        <div class="absolute bottom-full left-0 z-10 mb-2 w-56 rounded-xl bg-white p-1 shadow-lg ring-1 ring-black/5">
          <div ref={list} class="max-h-[min(45dvh,22rem)] overflow-y-auto">
          <For each={visible()}>
            {(cycle) => (
              <div class="group/row flex items-center gap-1">
                <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-black/5" title={nomDeCycle(cycle)} onClick={() => { props.onActiveIdChange(cycle.id); setOpen(false) }}>
                  <span class="w-3 shrink-0 text-[var(--ink)]">{cycle.id === props.activeId ? '✓' : ''}</span><span class="tronque">{nomDeCycle(cycle)}</span>
                </button>
                <button type="button" class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--muted)] opacity-0 transition group-hover/row:opacity-100 hover:bg-black/5 focus-visible:opacity-100" aria-label={t('cycles.menuRenameAria', { name: nomDeCycle(cycle) })} onClick={() => { setOpen(false); props.onRename(cycle.id) }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M8.2 1.8 10.2 3.8 4.4 9.6 1.8 10.2 2.4 7.6z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" /></svg>
                </button>
                <Show when={props.cycles.length > 1}>
                  <button type="button" class="mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--muted)] opacity-0 transition group-hover/row:opacity-100 hover:bg-black/5 hover:text-[var(--danger)] focus-visible:opacity-100" aria-label={t('cycles.menuRemoveAria', { name: nomDeCycle(cycle) })} onClick={() => { setOpen(false); props.onRemove(cycle.id) }}>
                    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.8 3.9h8.4M5.5 3.9V2.7h3v1.2M4.1 3.9l.5 7.4h4.8l.5-7.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                </Show>
              </div>
            )}
          </For>
          </div>
          <Show when={props.cycles.length > MAX_CYCLES}>
            <div class="flex items-center justify-between gap-2 px-2 text-xs tabular-nums text-[var(--muted)]">
              <button type="button" class="h-7 w-7 rounded-lg hover:bg-black/5 disabled:opacity-40" disabled={first() === 0} aria-label={t('pages.previous')} onClick={() => turnPage(-1)}>‹</button>
              <span>{t('pages.range', { first: first() + 1, last: last(), total: props.cycles.length })}</span>
              <button type="button" class="h-7 w-7 rounded-lg hover:bg-black/5 disabled:opacity-40" disabled={last() === props.cycles.length} aria-label={t('pages.next')} onClick={() => turnPage(1)}>›</button>
            </div>
          </Show>
          <div class="my-1 h-px bg-[var(--line)]" />
          <button type="button" class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-black/5 disabled:cursor-default disabled:opacity-40" disabled={!canCreate()} onClick={() => { setOpen(false); props.onCreate() }}><span class="w-3 shrink-0 text-[var(--muted)]">+</span>{t('cycles.menuNew')}</button>
          <Show when={!canCreate()}><p class="px-2.5 py-1 text-xs text-[var(--muted)]" role="status">{t('cycles.limit', { limit: MAX_CYCLES })}</p></Show>
        </div>
      </Show>
    </div>
  )
}
