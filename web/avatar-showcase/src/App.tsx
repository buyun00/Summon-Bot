import { For, Match, Show, Switch, createMemo, createSignal, onCleanup } from 'solid-js'
import { on, onMount } from '@/solid-compat'
import BotTile from '@/components/BotTile'
import Customizer from '@/components/Customizer'
import BloubBot, { type BloubBotRef } from '@/components/BloubBot'
import ExportBar from '@/components/ExportBar'
import CycleDialog from '@/components/CycleDialog'
import GifDialog from '@/components/GifDialog'
import Settings from '@/components/Settings'
import SideRail, { type ViewId } from '@/components/SideRail'
import Timeline from '@/components/Timeline'
import PaperControls from '@/components/PaperControls'
import { nomDeCycle, t } from '@/i18n'
import { copie, copieTexte, cycleVersGif, cycleVersMp4, svgAutonome, telecharge, versGifAnime, versPng, versSvgAnime } from '@/ui/capture'
import { ACTION_BY_ID, ANIM_IMAGES, ANIM_PAS, CYCLE_TAILLE, FOND_GIF_DEFAUT, FORMAT_CYCLE_DEFAUT, GIF_IMAGES, GIF_PAS, BLANC, Abandon, couleurDeFond, cycleImages, cyclePas, nomFichier, type ActionId, type EtatExport, type FondGif, type FormatCycle } from '@/ui/export'
import { HUMEURS } from '@/ui/gaze'
import { INTRO, INTRO_GAZE, POSE_AT, introDue } from '@/ui/intro'
import { ecris, lis, type NomStocke } from '@/ui/stockage'
import { blockAt, blocksWith, defaultCycle, makeBlock, parseCycles, totalDuration, type Cycle } from '@/bot/cycles'
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from '@/bot/expressions'
import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPE_BY_ID } from '@/bot/skins'
import { POSES, SEQUENCE, STATES, type StateId } from '@/bot/states'

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  const asked = params.get('etat') as StateId | null
  const known = STATES.some((state) => state.id === asked)
  return {
    state: known ? asked! : 'idle' as StateId,
    named: known,
    playing: !params.has('stop'),
    gallery: params.has('planche'),
    arrivee: params.has('arrivee')
  }
}

function stored(name: NomStocke, fallback: string, exists: (value: string) => boolean) {
  const value = lis(name)
  return value && exists(value) ? value : fallback
}

function locateInCycles(cycles: Cycle[], activeId: string, id: StateId) {
  const active = cycles.find((item) => item.id === activeId) ?? cycles[0]!
  const order = [active, ...cycles.filter((item) => item.id !== active.id)]
  for (const item of order) {
    const index = item.blocks.findIndex((candidate) => candidate.state === id)
    if (index >= 0) return { id: item.id, index }
  }
  return null
}

const REST = [makeBlock('idle')]
const ENTREE = [makeBlock('swirl'), makeBlock('idle')]
const ENTREE_CALME = [makeBlock('idle')]
const NOM = 'BLOUB'
const HUMEUR_MS = 4200
const RETARD_ARRIVEE = 400
const CONFIRMATION_MS = 1800

export default function App() {
  const initial = readHash()
  const [gallery, setGallery] = createSignal(initial.gallery)
  const quietQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const [quiet, setQuiet] = createSignal(quietQuery.matches)
  const [navigationEntry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
  const navigation = navigationEntry?.type ?? 'navigate'
  const initialIntro = initial.arrivee || introDue({ named: initial.named, gallery: initial.gallery, rechargement: navigation !== 'navigate', calme: quietQuery.matches })
  const [intro, setIntro] = createSignal(initialIntro)

  const restored = parseCycles(lis('cycles'))
  const initialCycles = restored.length ? restored : [defaultCycle()]
  let initialActiveId = stored('cycle', initialCycles[0]!.id, (value) => initialCycles.some((cycle) => cycle.id === value))
  let initialBlock = 0
  if (initial.named) {
    const found = locateInCycles(initialCycles, initialActiveId, initial.state)
    if (found) {
      initialActiveId = found.id
      initialBlock = found.index
    }
  }

  const [cycles, setCycles] = createSignal<Cycle[]>(initialCycles)
  const [activeId, setActiveId] = createSignal(initialActiveId)
  const [block, setBlock] = createSignal(initialBlock)
  const [elapsed, setElapsed] = createSignal(0)
  const cycle = createMemo(() => cycles().find((item) => item.id === activeId()) ?? cycles()[0]!)

  function locate(id: StateId) {
    return locateInCycles(cycles(), activeId(), id)
  }

  const initialCycle = initialCycles.find((item) => item.id === initialActiveId) ?? initialCycles[0]!
  const initialView: ViewId = initial.named ? 'animations' : 'personnaliser'
  const [state, setState] = createSignal<StateId>(initialIntro ? 'idle' : (initialCycle.blocks[initialBlock]?.state ?? 'idle'))
  const [view, setView] = createSignal<ViewId>(initialView)
  const [preview, setPreview] = createSignal(false)
  const [playing, setPlaying] = createSignal(initialIntro || (initial.playing && initialView === 'animations'))
  const [shape, setShape] = createSignal(stored('forme', DEFAULT_SHAPE, (value) => SHAPE_BY_ID.has(value)))
  const [color, setColor] = createSignal(stored('couleur', DEFAULT_COLOR, (value) => COLOR_BY_ID.has(value)))
  const [expression, setExpression] = createSignal(stored('expression', DEFAULT_EXPRESSION, (value) => EXPRESSION_BY_ID.has(value)))
  const [mood, setMood] = createSignal<string | null>(null)

  let pendingSave: ReturnType<typeof setTimeout>
  function saveCycles() {
    clearTimeout(pendingSave)
    ecris('cycles', JSON.stringify(cycles()))
  }
  on(cycles, () => { clearTimeout(pendingSave); pendingSave = setTimeout(saveCycles, 250) }, { defer: true })
  on(activeId, (value) => ecris('cycle', value), { defer: true })
  on(shape, (value) => ecris('forme', value), { defer: true })
  on(color, (value) => ecris('couleur', value), { defer: true })
  on(expression, (value) => ecris('expression', value), { defer: true })
  on(preview, setPlaying, { defer: true })

  let writtenHash = ''
  on(() => [state(), playing()] as const, ([id, on]) => {
    if (view() !== 'animations') return
    writtenHash = `#etat=${id}${on ? '' : '&stop'}`
    location.replace(writtenHash)
  }, { defer: true })

  let resume = initial.named && initial.playing
  let resumeBlock = initialBlock
  const played = createMemo(() => {
    if (intro()) return INTRO
    if (view() === 'animations') return cycle().blocks
    if (view() !== 'reglages') return REST
    return quiet() ? ENTREE_CALME : ENTREE
  })

  on(view, (now, before) => {
    setIntro(false)
    if (before === 'animations') {
      resume = playing()
      resumeBlock = block()
    }
    if (now === 'animations') {
      setPlaying(resume)
      setBlock(resumeBlock)
    } else {
      setBlock(0)
      setPlaying(now === 'reglages')
    }
  }, { defer: true })

  on(block, (index) => {
    if (intro()) {
      if (index >= INTRO.length - 1) {
        setIntro(false)
        setPlaying(false)
      }
    } else if (view() === 'reglages' && index > 0) setPlaying(false)
  }, { defer: true })

  const bare = createMemo(() => intro() && block() < POSE_AT)
  const leftOpen = createMemo(() => !bare() && view() === 'reglages')
  const rightOpen = createMemo(() => !bare() && view() !== 'reglages')
  const displayedShape = createMemo(() => view() === 'reglages' || bare() ? DEFAULT_SHAPE : shape())
  const order = createMemo(() => SEQUENCE.map((id) => STATES.find((state) => state.id === id)!))

  let moodTimer: ReturnType<typeof setInterval> | undefined
  on(view, (current) => {
    clearInterval(moodTimer)
    if (current !== 'reglages') return setMood(null)
    let index = 0
    moodTimer = setInterval(() => setMood(HUMEURS[index++ % HUMEURS.length]!), HUMEUR_MS)
  })

  function addBlock(id: StateId) {
    setCycles((items) => items.map((item) => item.id === cycle().id ? { ...item, blocks: blocksWith(item.blocks, id) } : item))
  }

  let bot: BloubBotRef | undefined
  function onSeek(seconds: number) {
    const target = blockAt(cycle().blocks, seconds)
    bot?.seek(target.index, target.elapsed)
  }

  const [exportBarHidden, setExportBarHidden] = createSignal(false)
  let exportBarTimer: ReturnType<typeof setTimeout> | undefined
  on(bare, (still, before) => {
    if (!before || still) return
    setExportBarHidden(true)
    clearTimeout(exportBarTimer)
    exportBarTimer = setTimeout(() => setExportBarHidden(false), RETARD_ARRIVEE)
  }, { defer: true })

  const [cycleDialog, setCycleDialog] = createSignal(false)
  const [cycleFormat, setCycleFormat] = createSignal<FormatCycle>(FORMAT_CYCLE_DEFAUT)
  const [cycleBackground, setCycleBackground] = createSignal<FondGif>(FOND_GIF_DEFAUT)
  const [cycleProgress, setCycleProgress] = createSignal<number | null>(null)
  const [cycleError, setCycleError] = createSignal(false)
  let cycleAbort: AbortController | null = null

  async function exportCycle() {
    if (cycleProgress() !== null) return
    setCycleError(false)
    const controller = new AbortController()
    cycleAbort = controller
    const blocks = cycle().blocks
    const format = cycleFormat()
    const images = cycleImages(totalDuration(blocks), format)
    const step = cyclePas(format)
    const size = CYCLE_TAILLE[format]
    const settings = { shape: shape(), color: color(), expression: expression() }
    setCycleProgress(0)
    try {
      const mp4 = format === 'mp4'
      const file = mp4
        ? await cycleVersMp4(settings, blocks, size, images, step, BLANC, (done, total) => setCycleProgress(done / total), controller.signal)
        : await cycleVersGif(settings, blocks, size, images, step, couleurDeFond(cycleBackground()), (done, total) => setCycleProgress(done / total), controller.signal)
      telecharge(file, nomFichier(nomDeCycle(cycle()), '', '', mp4 ? 'mp4' : 'gif'))
      setCycleDialog(false)
    } catch (error) {
      if (!(error instanceof Abandon)) setCycleError(true)
    } finally {
      setCycleProgress(null)
      cycleAbort = null
    }
  }
  on(cycleDialog, (open) => open && setCycleError(false), { defer: true })

  const [exportState, setExportState] = createSignal<EtatExport>('pret')
  const [gifBackground, setGifBackground] = createSignal<FondGif>(FOND_GIF_DEFAUT)
  const [gifDialog, setGifDialog] = createSignal(false)
  let confirmation: ReturnType<typeof setTimeout> | undefined

  async function exportAvatar(id: ActionId, confirmed = false) {
    if (exportState() === 'occupe') return
    if (!confirmed && ACTION_BY_ID.get(id)?.mode === 'gif') return setGifDialog(true)
    const action = ACTION_BY_ID.get(id)
    const svg = bot?.svg
    if (!action || !svg) return
    clearTimeout(confirmation)
    setExportState('occupe')
    const filename = () => nomFichier(shape(), expression(), color(), action.extension, action.suffixe)
    try {
      if (action.mode === 'anime') {
        telecharge(await versSvgAnime({ shape: shape(), color: color(), expression: expression() }, action.taille, ANIM_IMAGES, ANIM_PAS), filename())
        setExportState('exporte')
      } else if (action.mode === 'gif') {
        telecharge(await versGifAnime({ shape: shape(), color: color(), expression: expression() }, action.taille, GIF_IMAGES, GIF_PAS, couleurDeFond(gifBackground())), filename())
        setExportState('exporte')
      } else {
        const markup = svgAutonome(svg, action.taille)
        if (action.mode === 'copieImage') {
          await copie(versPng(markup, action.taille))
          setExportState('copie')
        } else if (action.mode === 'copieTexte') {
          await copieTexte(markup)
          setExportState('copie')
        } else {
          telecharge(action.extension === 'svg' ? new Blob([markup], { type: 'image/svg+xml' }) : await versPng(markup, action.taille), filename())
          setExportState('exporte')
        }
      }
    } catch {
      setExportState('erreur')
    }
    confirmation = setTimeout(() => setExportState('pret'), CONFIRMATION_MS)
  }

  on(view, (current) => queueMicrotask(() => current === 'reglages' && bot?.seek(0, 0)), { defer: true })

  function onHashChange() {
    if (location.hash === writtenHash) {
      writtenHash = ''
      return
    }
    const next = readHash()
    if (next.arrivee && !initial.arrivee) return location.reload()
    setGallery(next.gallery)
    if (next.gallery || !next.named) return
    const found = locate(next.state)
    if (!found) return
    setIntro(false)
    setView('animations')
    setActiveId(found.id)
    setBlock(found.index)
    setPlaying(next.playing)
    queueMicrotask(() => bot?.seek(found.index, 0))
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') setPreview(false)
  }

  onMount(() => {
    const onQuiet = (event: MediaQueryListEvent) => setQuiet(event.matches)
    quietQuery.addEventListener('change', onQuiet)
    window.addEventListener('pagehide', saveCycles)
    window.addEventListener('hashchange', onHashChange)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      quietQuery.removeEventListener('change', onQuiet)
      window.removeEventListener('pagehide', saveCycles)
      window.removeEventListener('hashchange', onHashChange)
      window.removeEventListener('keydown', onKeyDown)
    }
  })
  onCleanup(() => {
    clearInterval(moodTimer)
    clearTimeout(exportBarTimer)
    clearTimeout(confirmation)
    clearTimeout(pendingSave)
  })

  return (
    <>
    <PaperControls />
    <Show
      when={!gallery()}
      fallback={
        <div class="p-5">
          <a class="text-xs text-[var(--muted)] underline underline-offset-2" href="#">{t('gallery.back')}</a>
          <div class="mt-4 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
            <For each={order()}>{(item) => <figure class="flex flex-col items-center"><a href={`#etat=${item.id}`} aria-label={`${t('timeline.play')} · ${t(`states.${item.id}`)}`}><BloubBot state={item.id} size={210} shape={shape()} color={color()} expression={expression()} frozenAt={POSES[item.id]} ariaLabel={t(`states.${item.id}`)} /></a><figcaption class="text-xs text-[var(--muted)]">{t(`states.${item.id}`)}</figcaption></figure>}</For>
          </div>
        </div>
      }
    >
      <h1 class="sr-only">{t('app.name')}</h1>
      <Show when={!preview()} fallback={<button type="button" class="fixed top-5 right-5 z-30 flex cursor-pointer items-center gap-1.5 rounded-lg bg-white/80 px-2.5 py-1.5 text-xs text-[var(--muted)] shadow-sm backdrop-blur transition hover:text-[var(--ink)]" onClick={() => setPreview(false)}>{t('preview.exit')}<kbd class="rounded bg-black/5 px-1 py-0.5 text-[10px]">{t('preview.key')}</kbd></button>}>
        <SideRail view={view()} onViewChange={setView} class="rail" inert={bare()} />
      </Show>
      <div class={`scene min-h-full items-stretch justify-center p-8 max-lg:flex max-lg:flex-col max-lg:gap-10 max-lg:px-5 ${!preview() && view() === 'animations' ? 'pb-[calc(var(--timeline)_+_1rem)]' : ''} ${!preview() ? 'max-lg:pt-20' : ''} ${bare() || preview() ? 'scene--seule' : view() === 'reglages' ? 'scene--gauche' : ''}`}>
        <Show when={!preview()}><aside class={`panneau scene__gauche w-full lg:flex lg:h-[calc(100dvh_-_3rem_-_var(--timeline))] lg:w-80 lg:shrink-0 lg:flex-col lg:justify-center lg:self-start lg:-translate-y-12 lg:pl-14 ${leftOpen() ? 'panneau--ouvert max-lg:order-2' : 'max-lg:hidden'}`}><Settings /></aside></Show>
        <main class={`scene__avatar relative flex flex-1 items-center justify-center max-lg:order-1 max-lg:flex-col max-lg:gap-4 lg:self-start ${preview() ? 'lg:min-h-[calc(100dvh_-_4rem)]' : 'lg:min-h-[calc(100dvh_-_3rem_-_var(--timeline))]'}`}>
          <div class={`avatar flex aspect-square w-full items-center justify-center ${preview() ? 'max-w-[min(560px,calc(100dvh_-_6rem))]' : 'max-w-[min(460px,calc(100dvh_-_var(--timeline)_-_7rem))]'} ${bare() ? 'avatar--intro' : ''} ${view() === 'reglages' && !preview() ? 'avatar--geant' : ''}`}>
            <BloubBot ref={(value) => { bot = value }} class="h-auto max-w-full" state={state()} block={block()} elapsed={elapsed()} playing={playing()} onStateChange={setState} onBlockChange={setBlock} onElapsedChange={setElapsed} onPlayingChange={setPlaying} cycle={played()} size={preview() ? 560 : 440} shape={displayedShape()} color={color()} expression={mood() ?? expression()} follow={view() === 'reglages'} gaze={intro() ? INTRO_GAZE : null} ariaLabel={t('app.botAria')} />
          </div>
          <Show when={view() === 'personnaliser' && !preview()}>
            <div class={`barre-export ${bare() || exportBarHidden() ? 'barre-export--cachee' : ''}`} inert={bare() || exportBarHidden() ? true : undefined}><ExportBar etat={exportState()} onExport={exportAvatar} /></div>
            <GifDialog open={gifDialog()} fond={gifBackground()} onOpenChange={setGifDialog} onFondChange={setGifBackground} onConfirm={() => void exportAvatar('gif', true)} />
          </Show>
          <Show when={view() === 'animations' && !preview()}><CycleDialog open={cycleDialog()} format={cycleFormat()} fond={cycleBackground()} avancement={cycleProgress()} erreur={cycleError()} onOpenChange={setCycleDialog} onFormatChange={setCycleFormat} onFondChange={setCycleBackground} onConfirm={() => void exportCycle()} onCancel={() => cycleAbort?.abort()} /></Show>
        </main>
        <Show when={!preview()}>
          <aside class={`panneau scene__droite w-full lg:w-80 lg:shrink-0 ${rightOpen() ? 'panneau--ouvert max-lg:order-2' : 'max-lg:hidden'}`}>
            <Switch>
              <Match when={view() === 'animations'}><h2 class="text-sm font-semibold">{t('panel.animations')}</h2><div class="mt-2 grid grid-cols-4 gap-1.5"><For each={order()}>{(item) => <BotTile label={t(`states.${item.id}`)} selected={item.id === state()} state={item.id} shape={shape()} color={color()} expression={expression()} frozenAt={POSES[item.id]} onClick={() => addBlock(item.id)} />}</For></div></Match>
              <Match when={true}><Customizer shape={shape()} color={color()} expression={expression()} onShapeChange={setShape} onColorChange={setColor} onExpressionChange={setExpression} /></Match>
            </Switch>
          </aside>
        </Show>
      </div>
      <Show when={view() === 'reglages' && !preview()}><p class="wordmark" aria-hidden="true">{NOM}</p></Show>
      <Show when={view() === 'animations' && !preview()}><Timeline cycles={cycles()} activeId={activeId()} block={block()} playing={playing()} elapsed={elapsed()} shape={shape()} color={color()} expression={expression()} onCyclesChange={setCycles} onActiveIdChange={setActiveId} onBlockChange={setBlock} onPlayingChange={setPlaying} onSeek={onSeek} onPreview={() => setPreview(true)} onExport={() => setCycleDialog(true)} /></Show>
    </Show>
    </>
  )
}
