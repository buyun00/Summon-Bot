import { For, Show, createEffect, createMemo, createSignal, untrack } from 'solid-js'
import { on, onMount } from '@/solid-compat'
import BlockPicker from './BlockPicker'
import BloubBot from './BloubBot'
import { clampDuration, moveBlock, offsetOf, STEP, totalDuration, type Block } from '@/bot/cycles'
import { POSES, type StateId } from '@/bot/states'
import { BASE_SCALE, clampZoom, ticksFor } from '@/ui/timeline'
import { secondes, secondesCourtes, t } from '@/i18n'

type Drag = { from: number; to: number; startX: number; dx: number; moved: boolean }
type Resize = { index: number; startX: number; startDuration: number }

export default function TimelineTrack(props: {
  blocks: Block[]
  elapsed: number
  shape: string
  color: string
  expression: string
  block: number
  zoom: number
  onBlocksChange: (blocks: Block[]) => void
  onBlockChange: (block: number) => void
  onZoomChange: (zoom: number) => void
  onSeek: (seconds: number) => void
  onAdd: (state: StateId) => void
}) {
  const scale = createMemo(() => BASE_SCALE * props.zoom)
  const total = createMemo(() => totalDuration(props.blocks))
  const at = createMemo(() => offsetOf(props.blocks, props.block) + props.elapsed)
  const ticks = createMemo(() => ticksFor(total(), scale()))
  let track!: HTMLDivElement
  const [overflow, setOverflow] = createSignal({ left: false, right: false })
  const [scrolled, setScrolled] = createSignal(0)
  const [drag, setDrag] = createSignal<Drag | null>(null)
  const [resize, setResize] = createSignal<Resize | null>(null)
  const [scrubbing, setScrubbing] = createSignal(false)
  let anchorX: number | null = null

  const width = (index: number) => props.blocks[index]!.duration * scale()
  const label = (index: number) => t(`states.${props.blocks[index]!.state}`)

  function onScroll() {
    if (!track) return
    setScrolled(track.scrollLeft)
    setOverflow({ left: track.scrollLeft > 4, right: track.scrollLeft + track.clientWidth < track.scrollWidth - 4 })
  }

  function setZoom(next: number, clientX?: number) {
    anchorX = clientX ?? null
    props.onZoomChange(clampZoom(next))
  }

  let oldScale = untrack(scale)
  on(scale, (now) => {
    if (!track) return
    const box = track.getBoundingClientRect()
    const x = (anchorX ?? box.left + track.clientWidth / 2) - box.left
    const second = (track.scrollLeft + x) / oldScale
    oldScale = now
    anchorX = null
    queueMicrotask(() => { track.scrollLeft = second * now - x; onScroll() })
  }, { defer: true })

  function onWheel(event: WheelEvent) {
    const unit = event.deltaMode === 1 ? 16 : 1
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      setZoom(props.zoom * Math.exp((-event.deltaY * unit) / 180), event.clientX)
      return
    }
    if (track.scrollWidth <= track.clientWidth) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return
    event.preventDefault()
    track.scrollLeft += delta * unit
  }

  onMount(onScroll)
  createEffect(() => [total(), props.blocks] as const, () => queueMicrotask(onScroll))
  on(() => props.block, (block) => {
    const x = offsetOf(props.blocks, block) * scale()
    if (x < track.scrollLeft || x + width(block) > track.scrollLeft + track.clientWidth) track.scrollTo({ left: Math.max(0, x - 24), behavior: 'smooth' })
  }, { defer: true })

  function removeBlock(index: number) {
    if (props.blocks.length < 2) return
    props.onBlocksChange(props.blocks.filter((_, i) => i !== index))
    if (index < props.block) props.onBlockChange(props.block - 1)
    else if (props.block >= props.blocks.length - 1) props.onBlockChange(props.blocks.length - 2)
  }

  function setDuration(index: number, wanted: number) {
    const block = props.blocks[index]
    if (!block) return
    const duration = clampDuration(block.state, wanted)
    if (duration !== block.duration) props.onBlocksChange(props.blocks.map((old, i) => i === index ? { ...old, duration } : old))
  }

  function shiftOf(index: number) {
    const current = drag()
    if (!current?.moved) return 0
    if (index === current.from) return current.dx
    const w = width(current.from)
    if (current.to > current.from && index > current.from && index <= current.to) return -w
    if (current.to < current.from && index >= current.to && index < current.from) return w
    return 0
  }

  function indexAt(seconds: number) {
    let sum = 0
    for (let i = 0; i < props.blocks.length; i++) {
      sum += props.blocks[i]!.duration
      if (seconds < sum) return i
    }
    return props.blocks.length - 1
  }

  function pointerSeconds(event: PointerEvent) {
    const box = track.getBoundingClientRect()
    return (event.clientX - box.left + track.scrollLeft) / scale()
  }

  function onBlockDown(index: number, event: PointerEvent) {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    setDrag({ from: index, to: index, startX: event.clientX, dx: 0, moved: false })
  }

  function onBlockMove(event: PointerEvent) {
    const current = drag()
    if (!current || (!current.moved && Math.abs(event.clientX - current.startX) <= 4)) return
    setDrag({ ...current, moved: true, dx: event.clientX - current.startX, to: Math.max(0, indexAt(pointerSeconds(event))) })
  }

  function onBlockUp(index: number) {
    const current = drag()
    setDrag(null)
    if (!current) return
    if (!current.moved) return props.onBlockChange(index)
    if (current.to === current.from) return
    props.onBlocksChange(moveBlock(props.blocks, current.from, current.to))
    if (props.block === current.from) props.onBlockChange(current.to)
  }

  function onResizeDown(index: number, event: PointerEvent) {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    setResize({ index, startX: event.clientX, startDuration: props.blocks[index]!.duration })
  }

  function onResizeMove(event: PointerEvent) {
    const current = resize()
    if (current) setDuration(current.index, current.startDuration + (event.clientX - current.startX) / scale())
  }

  async function onCardKey(index: number, event: KeyboardEvent) {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction) return
    event.preventDefault()
    if (!event.altKey) return props.onSeek(Math.max(0, Math.min(total() - 0.001, at() + direction * STEP)))
    const target = index + direction
    if (target < 0 || target >= props.blocks.length) return
    props.onBlocksChange(moveBlock(props.blocks, index, target))
    props.onBlockChange(target)
    queueMicrotask(() => track.querySelectorAll<HTMLButtonElement>('[data-carte]')[target]?.focus())
  }

  function scrubTo(event: PointerEvent) {
    props.onSeek(Math.max(0, Math.min(total() - 0.001, pointerSeconds(event))))
  }

  return (
    <div class="relative flex-1">
      <div ref={track} class="h-full overflow-x-auto overflow-y-hidden [scrollbar-width:none]" onScroll={onScroll} onWheel={onWheel}>
        <div class="relative flex h-full flex-col" style={{ width: `${total() * scale() + 76}px` }}>
          <div class="relative h-7 shrink-0 cursor-ew-resize pt-1 select-none" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setScrubbing(true); scrubTo(event) }} onPointerMove={(event) => scrubbing() && scrubTo(event)} onPointerUp={() => setScrubbing(false)} onPointerCancel={() => setScrubbing(false)}>
            <For each={ticks()}>{(tick) => <span class="absolute bottom-1.5 flex items-end gap-1" style={{ transform: `translateX(${tick.t * scale()}px)` }}><span class={`block w-px bg-[var(--line)] ${tick.major ? 'h-3' : 'h-1.5'}`} /><Show when={tick.major}><span class="-mb-0.5 text-xs leading-none text-[var(--muted)]">{secondesCourtes(tick.t, Number.isInteger(tick.t) ? 0 : 1)}</span></Show></span>}</For>
          </div>
          <ul class="flex flex-1 items-stretch">
            <For each={props.blocks}>
              {(item, index) => (
                <li class={`group relative shrink-0 pr-1 ${drag()?.moved && index() === drag()?.from ? 'z-20' : 'transition-transform duration-150 ease-out'}`} style={{ width: `${item.duration * scale()}px`, transform: shiftOf(index()) ? `translateX(${shiftOf(index())}px)` : undefined }}>
                  <button type="button" class={`flex h-full w-full cursor-grab flex-col justify-between overflow-hidden rounded-lg px-1.5 py-1 text-left transition select-none active:cursor-grabbing ${index() === props.block ? 'bg-white ring-2 ring-[var(--ink)] ring-inset' : 'bg-black/[0.045] hover:bg-black/[0.08]'} ${drag()?.moved && index() === drag()?.from ? 'scale-[1.02] opacity-75 shadow-lg' : ''}`} aria-label={t('timeline.blockAria', { state: label(index()), duration: secondes(item.duration) })} aria-current={index() === props.block ? 'true' : undefined} onPointerDown={(event) => onBlockDown(index(), event)} onPointerMove={onBlockMove} onPointerUp={() => onBlockUp(index())} onPointerCancel={() => setDrag(null)} data-carte aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight ArrowLeft ArrowRight" onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onBlockChange(index()) } else void onCardKey(index(), event) }}>
                    <span class="flex min-w-0 flex-1 items-center justify-center"><Show when={width(index()) > 44}><BloubBot class="shrink-0" state={item.state} size={Math.min(56, Math.max(30, width(index()) * 0.5))} shape={props.shape} color={props.color} expression={props.expression} paper={index() === props.block ? '#ffffff' : '#f2f2f2'} frozenAt={POSES[item.state]} ariaLabel={label(index())} /></Show></span>
                    <Show when={width(index()) > 50}><span class={`tronque text-center text-xs leading-none font-semibold tabular-nums ${index() === props.block ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>{secondes(item.duration)}</span></Show>
                  </button>
                  <button type="button" class="absolute inset-y-2 right-0.5 w-1 cursor-ew-resize rounded-full bg-[var(--muted)] opacity-0 transition group-hover:opacity-60 hover:opacity-100! focus-visible:opacity-100" aria-label={t('timeline.blockDurationAria', { state: label(index()), duration: secondes(item.duration) })} onPointerDown={(event) => onResizeDown(index(), event)} onPointerMove={onResizeMove} onPointerUp={() => setResize(null)} onPointerCancel={() => setResize(null)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setDuration(index(), item.duration + (event.key === 'ArrowLeft' ? -STEP : STEP)) } }} />
                  <Show when={props.blocks.length > 1}><button type="button" class="absolute top-1 right-2 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/10 text-[var(--ink)] opacity-0 transition group-hover:opacity-100 hover:bg-black/20 focus-visible:opacity-100" aria-label={t('timeline.blockRemoveAria', { state: label(index()) })} onClick={() => removeBlock(index())}><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.6 2.6 7.4 7.4M7.4 2.6 2.6 7.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button></Show>
                </li>
              )}
            </For>
            <li class="w-[72px] shrink-0 pl-1"><BlockPicker shape={props.shape} color={props.color} expression={props.expression} onPick={props.onAdd} /></li>
          </ul>
          <div class="pointer-events-none absolute inset-y-0 left-0 w-0.5 rounded-full bg-[var(--ink)]" style={{ transform: `translateX(${at() * scale()}px)` }}><span class="absolute -top-0.5 -left-[5px] h-3 w-3 rounded-full border-2 border-[var(--paper)] bg-[var(--ink)]" /></div>
        </div>
      </div>
      <Show when={scrubbing()}><div class="pointer-events-none absolute top-0 left-0 z-10" style={{ transform: `translate(${at() * scale() - scrolled()}px, -70%)` }}><span class="block -translate-x-1/2 rounded-md bg-[var(--ink)] px-2 py-1 text-xs tabular-nums text-[var(--paper)] shadow-sm">{secondes(at())}</span></div></Show>
      <Show when={overflow().left}><div class="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[var(--paper)] to-transparent" /></Show>
      <Show when={overflow().right}><div class="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--paper)] to-transparent" /></Show>
    </div>
  )
}
