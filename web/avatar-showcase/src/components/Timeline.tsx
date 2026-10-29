import { createMemo, createSignal } from 'solid-js'
import ConfirmDialog from './ConfirmDialog'
import CycleMenu from './CycleMenu'
import NameDialog from './NameDialog'
import TimelineTrack from './TimelineTrack'
import ZoomSlider from './ZoomSlider'
import { blocksWith, makeBlock, nextCycleId, offsetOf, totalDuration, uniqueName, type Block, type Cycle } from '@/bot/cycles'
import type { StateId } from '@/bot/states'
import { MAX_ZOOM, MIN_ZOOM, mmss } from '@/ui/timeline'
import { nomDeCycle, pluriel, t } from '@/i18n'

export default function Timeline(props: {
  elapsed: number
  shape: string
  color: string
  expression: string
  cycles: Cycle[]
  activeId: string
  block: number
  playing: boolean
  onCyclesChange: (cycles: Cycle[]) => void
  onActiveIdChange: (id: string) => void
  onBlockChange: (block: number) => void
  onPlayingChange: (playing: boolean) => void
  onSeek: (seconds: number) => void
  onPreview: () => void
  onExport: () => void
}) {
  const [zoom, setZoom] = createSignal(1)
  const cycle = createMemo(() => props.cycles.find((item) => item.id === props.activeId) ?? props.cycles[0]!)
  const blocks = () => cycle().blocks
  const total = createMemo(() => totalDuration(blocks()))
  const at = createMemo(() => offsetOf(blocks(), props.block) + props.elapsed)
  const [naming, setNaming] = createSignal<{ mode: 'create' | 'rename'; id?: string } | null>(null)
  const [nameDraft, setNameDraft] = createSignal('')
  const [nameOpen, setNameOpen] = createSignal(false)
  const [removing, setRemoving] = createSignal<Cycle | null>(null)
  const [confirmOpen, setConfirmOpen] = createSignal(false)

  function edit(next: Partial<Cycle>) {
    props.onCyclesChange(props.cycles.map((item) => item.id === cycle().id ? { ...item, ...next } : item))
  }
  function select(id: string) {
    props.onActiveIdChange(id)
    props.onBlockChange(0)
  }
  function askCreate() {
    setNaming({ mode: 'create' })
    setNameDraft(uniqueName(t('cycles.newName'), props.cycles))
    setNameOpen(true)
  }
  function askRename(id: string) {
    setNaming({ mode: 'rename', id })
    const target = props.cycles.find((item) => item.id === id)
    setNameDraft(target ? nomDeCycle(target) : '')
    setNameOpen(true)
  }
  function onNamed(name: string) {
    const request = naming()
    setNaming(null)
    if (!request) return
    if (request.mode === 'create') {
      const next: Cycle = { id: nextCycleId(props.cycles), name: uniqueName(name, props.cycles), blocks: [makeBlock('idle')] }
      props.onCyclesChange([...props.cycles, next])
      select(next.id)
      return
    }
    const others = props.cycles.filter((item) => item.id !== request.id)
    const unique = uniqueName(name, others)
    props.onCyclesChange(props.cycles.map((item) => item.id === request.id ? { ...item, name: unique } : item))
  }
  function askRemove(id: string) {
    setRemoving(props.cycles.find((item) => item.id === id) ?? null)
    setConfirmOpen(true)
  }
  function onRemove() {
    const target = removing()
    setRemoving(null)
    if (!target) return
    const rest = props.cycles.filter((item) => item.id !== target.id)
    props.onCyclesChange(rest)
    if (target.id === props.activeId) select(rest[0]!.id)
  }

  return (
    <div class="fixed inset-x-0 bottom-0 z-30 h-[var(--timeline)] px-6 pt-3 pb-5 max-lg:border-t max-lg:border-[var(--line)] max-lg:bg-[var(--paper)] max-lg:px-5 lg:right-[24.5rem] lg:left-[4.5rem]">
      <div class="absolute -top-5 left-1/2 flex -translate-x-1/2 items-center gap-3">
        <span class="text-sm font-medium tabular-nums max-lg:hidden">{mmss(at())}</span>
        <button type="button" class="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-[var(--ink)] text-[var(--paper)] shadow-sm transition hover:scale-105 active:scale-95" aria-label={props.playing ? t('timeline.pause') : t('timeline.play')} onClick={() => props.onPlayingChange(!props.playing)}>
          {props.playing ? <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><path d="M2 6C2 4.114 2 3.172 2.586 2.586S4.114 2 6 2s2.828 0 3.414.586S10 4.114 10 6v12c0 1.886 0 2.828-.586 3.414S7.886 22 6 22s-2.828 0-3.414-.586S2 19.886 2 18z" /><path d="M14 6c0-1.886 0-2.828.586-3.414S16.114 2 18 2s2.828 0 3.414.586S22 4.114 22 6v12c0 1.886 0 2.828-.586 3.414S19.886 22 18 22s-2.828 0-3.414-.586S14 19.886 14 18z" /></g></svg> : <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.4086 9.35258C23.5305 10.5065 23.5305 13.4935 21.4086 14.6474L8.59662 21.6145C6.53435 22.736 4 21.2763 4 18.9671L4 5.0329C4 2.72368 6.53435 1.26402 8.59661 2.38548L21.4086 9.35258Z" /></svg>}
        </button>
        <span class="text-sm tabular-nums text-[var(--muted)] max-lg:hidden">{mmss(total())}</span>
      </div>
      <div class="flex h-full flex-col gap-2 select-none">
        <div class="flex items-center justify-between gap-1">
          <CycleMenu cycles={props.cycles} current={cycle()} activeId={props.activeId} onActiveIdChange={select} onCreate={askCreate} onRename={askRename} onRemove={askRemove} />
          <button type="button" class="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-xl bg-[var(--ink)] pr-3.5 pl-3 text-sm font-medium text-[var(--paper)] shadow-sm transition hover:opacity-90 active:scale-95 max-sm:w-8 max-sm:justify-center max-sm:px-0" onClick={props.onExport}><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M3 15C3 17.8284 3 19.2426 3.87868 20.1213C4.75736 21 6.17157 21 9 21H15C17.8284 21 19.2426 21 20.1213 20.1213C21 19.2426 21 17.8284 21 15" /><path d="M12 3V16M8 11.625L12 16L16 11.625" /></g></svg><span class="max-sm:sr-only">{t('timeline.export')}</span></button>
        </div>
        <TimelineTrack blocks={blocks()} elapsed={props.elapsed} shape={props.shape} color={props.color} expression={props.expression} block={props.block} zoom={zoom()} onBlocksChange={(next: Block[]) => edit({ blocks: next })} onBlockChange={props.onBlockChange} onZoomChange={setZoom} onAdd={(state: StateId) => edit({ blocks: blocksWith(blocks(), state) })} onSeek={props.onSeek} />
        <div class="flex shrink-0 items-center justify-end gap-4 max-sm:gap-2">
          <ZoomSlider zoom={zoom()} min={MIN_ZOOM} max={MAX_ZOOM} onZoomChange={setZoom} />
          <p class="text-xs tabular-nums text-[var(--muted)]"><span class="text-[var(--ink)]">{mmss(at())}</span> / {mmss(total())}</p>
          <span class="group relative flex"><button type="button" class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--ink)]" aria-label={t('timeline.preview')} onClick={props.onPreview}><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><path d="M9.75 12A2.25 2.25 0 1 0 14.25 12A2.25 2.25 0 1 0 9.75 12" /><path fill-rule="evenodd" d="M2 12c0 1.64.425 2.192 1.275 3.296C4.972 17.5 7.818 20 12 20s7.028-2.5 8.725-4.704C21.575 14.192 22 13.64 22 12s-.425-2.192-1.275-3.296C19.028 6.5 16.182 4 12 4S4.972 6.5 3.275 8.704C2.425 9.808 2 10.36 2 12m10-3.75a3.75 3.75 0 1 0 0 7.5a3.75 3.75 0 0 0 0-7.5" /></g></svg></button><span class="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 translate-y-1 rounded-lg bg-[var(--ink)] px-2.5 py-1.5 text-xs whitespace-nowrap text-[var(--paper)] opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100" role="tooltip">{t('timeline.preview')}</span></span>
        </div>
      </div>
      <NameDialog open={nameOpen()} value={nameDraft()} onOpenChange={setNameOpen} title={naming()?.mode === 'rename' ? t('dialog.nameRenameTitle') : t('dialog.nameCreateTitle')} label={t('dialog.nameField')} submitLabel={naming()?.mode === 'rename' ? t('dialog.nameRename') : t('dialog.nameCreate')} onSubmit={onNamed} />
      <ConfirmDialog open={confirmOpen()} onOpenChange={setConfirmOpen} title={t('dialog.removeTitle', { name: removing() ? nomDeCycle(removing()!) : '' })} detail={pluriel('dialog.removeDetail', removing()?.blocks.length ?? 0)} confirmLabel={t('dialog.removeConfirm')} onConfirm={onRemove} />
    </div>
  )
}
