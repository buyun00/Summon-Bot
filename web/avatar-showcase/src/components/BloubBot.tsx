import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
  onCleanup,
  untrack,
  type Accessor,
} from 'solid-js'
import { Dynamic, mergeProps, type JSX } from '@solidjs/web'
import { NOTIF_BLUE } from '../bot/decor.js'
import { BotEngine, type BotFrame } from '../bot/engine.js'
import { clamp, easings } from '../bot/math.js'
import { lookTarget, TURN_TIME, type GazeScript } from '../ui/gaze.js'
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from '../bot/expressions.js'
import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPE_BY_ID, mixHex } from '../bot/skins.js'
import { blockAt, defaultCycle, offsetOf, type Block } from '../bot/cycles.js'
import { DEMI_VIEWBOX, RAYON } from '../bot/repere.js'
import { STATE_BY_ID, type StateId } from '../bot/states.js'
import { paperBacking, paperEnabled, paperEyes, paperGrain } from '../ui/paper.js'

function watch<T>(
  source: Accessor<T>,
  effect: (value: T, previous: T | undefined) => void,
  options?: { defer?: boolean }
) {
  createEffect(
    source,
    (value, previous) => { untrack(() => effect(value, previous)) },
    options?.defer ? { defer: true } : undefined
  )
}

export interface BloubBotRef {
  readonly svg: SVGSVGElement
  seek(index: number, offset?: number): void
  renderAt(seconds: number): void
}

export interface BloubBotProps {
  size?: number
  shape?: string
  color?: string
  expression?: string
  paper?: string
  ariaLabel?: string
  frozenAt?: number
  cycle?: Block[]
  follow?: boolean
  gaze?: GazeScript | null
  block?: number
  state?: StateId
  playing?: boolean
  elapsed?: number
  /**
   * Cadence maximale de rendu, en images par seconde. Sans elle le bot dessine a
   * la cadence de l'ecran : sur un 120 Hz c'est deux fois le travail d'un 60 Hz
   * pour la meme animation. Le rendu tombe sur le plus grand diviseur de la
   * cadence de l'ecran qui ne depasse pas `fps`, donc l'intervalle reste
   * regulier — un bot bride a 30 sur un ecran a 75 Hz dessine a 25.
   */
  fps?: number
  /**
   * Suspend la boucle quand personne ne peut voir le bot : onglet en arriere-plan,
   * element sorti du viewport, ancetre `display: none`. L'horloge s'arrete avec
   * elle, donc l'animation reprend sur la pose qu'elle avait — elle ne saute pas.
   * A mettre a `false` seulement si le SVG est lu hors ecran par autre chose que
   * `renderAt` (l'export, lui, passe par `frozenAt` et n'a jamais de boucle).
   */
  autoPause?: boolean
  /**
   * Date de depart du bot dans son montage, en secondes. Lue une fois, au montage :
   * l'horloge, le bloc et la pose partent de cette date, donc plusieurs bots montes
   * ensemble ne respirent pas a l'unisson. Ignoree par un bot fige (`frozenAt`).
   */
  initialPhase?: number
  onBlockChange?: (value: number) => void
  onStateChange?: (value: StateId) => void
  onPlayingChange?: (value: boolean) => void
  onElapsedChange?: (value: number) => void
  ref?: (value: BloubBotRef) => void
  class?: string
  style?: JSX.CSSProperties | string
}

export default function BloubBot(rawProps: BloubBotProps) {
  const props = mergeProps(
    {
      size: 320,
      shape: DEFAULT_SHAPE,
      color: DEFAULT_COLOR,
      expression: DEFAULT_EXPRESSION,
      paper: '#F8F5ED',
      fps: 30,
      cycle: defaultCycle().blocks,
      follow: false,
      gaze: null,
      autoPause: true,
      ariaLabel: 'Animated Bloub avatar'
    },
    rawProps
  )

  /*
   * Le depart, lu une seule fois : c'est une date, pas un reglage suivi. Tout est lu sous
   * `untrack`, sinon le corps du composant lirait des props hors de toute portee reactive.
   */
  const start = untrack(() => {
    const phased = props.initialPhase !== undefined && props.frozenAt === undefined
    const phase = phased ? props.initialPhase! : 0
    const position = phased ? blockAt(props.cycle, phase) : { index: 0, elapsed: 0 }
    const state: StateId = phased ? (props.cycle[position.index]?.state ?? 'idle') : 'idle'
    return { phased, phase, ...position, state }
  })

  const [internalBlock, setInternalBlock] = createSignal(start.index)
  const [internalState, setInternalState] = createSignal<StateId>(start.state)
  const [internalPlaying] = createSignal(false)
  const [internalElapsed, setInternalElapsed] = createSignal(start.elapsed)

  const block = () => rawProps.block ?? internalBlock()
  const state = () => rawProps.state ?? internalState()
  const playing = () => rawProps.playing ?? internalPlaying()
  const elapsed = () => rawProps.elapsed ?? internalElapsed()

  function setBlock(value: number) {
    if (rawProps.block === undefined) setInternalBlock(value)
    rawProps.onBlockChange?.(value)
  }

  function setState(value: StateId) {
    if (rawProps.state === undefined) setInternalState(value)
    rawProps.onStateChange?.(value)
  }

  function setElapsed(value: number) {
    if (rawProps.elapsed === undefined) setInternalElapsed(value)
    rawProps.onElapsedChange?.(value)
  }

  const shapeRadii = createMemo(() => SHAPE_BY_ID.get(props.shape)?.radii ?? null)
  const ink = createMemo(() => COLOR_BY_ID.get(props.color)?.hex ?? '#0a0a0c')
  const expression = createMemo(() => EXPRESSION_BY_ID.get(props.expression) ?? null)

  const engine = untrack(() => {
    const created = new BotEngine(RAYON, state(), shapeRadii(), expression())
    // l'etat du bloc de depart a commence `elapsed` secondes avant la date de depart
    if (start.phased) created.reset(state(), start.phase - start.elapsed)
    return created
  })
  const [frame, setFrame] = createSignal<BotFrame>(untrack(() => engine.sample(props.frozenAt ?? start.phase)), {
    equals: false
  })
  const uid = createUniqueId()
  const maskId = `bot-mask-${uid}`
  const grainId = `paper-grain-${uid}`
  const eyeColor = () => paperEnabled() ? paperEyes(ink()) : props.paper

  let svg!: SVGSVGElement
  let raf = 0
  /** instant de la derniere image DESSINEE, pour la bride `fps` */
  let drawn = -Infinity
  let nextAt = Infinity
  let last = 0
  let clock = start.phase
  let blockStart = 0
  let pendingOffset = 0
  let lastRenderedBlock = -1

  function apply(index: number, from = 0, posePhase = 0) {
    const current = props.cycle[index]
    if (!current) {
      nextAt = Infinity
      return
    }
    blockStart = clock - from
    setElapsed(from)
    setState(current.state)
    engine.setState(current.state, clock, posePhase)
    nextAt = playing() ? blockStart + current.duration : Infinity
  }

  function goToBlock(index: number) {
    setBlock(index)
    apply(index)
  }

  function seek(index: number, offset = 0) {
    if (block() === index) {
      apply(index, offset)
      return
    }
    pendingOffset = offset
    setBlock(index)
  }

  function renderAt(seconds: number) {
    const blocks = props.cycle
    if (!blocks.length) return
    const { index } = blockAt(blocks, seconds)
    if (index !== lastRenderedBlock) {
      const current = blocks[index]!
      setState(current.state)
      if (index < lastRenderedBlock) engine.reset(current.state, offsetOf(blocks, index))
      else engine.setState(current.state, offsetOf(blocks, index))
      lastRenderedBlock = index
    }
    setFrame(engine.sample(seconds))
  }

  let pointer: { x: number; y: number } | null = null
  let aiming = false
  let turnSince = 0
  let gazeSince = 0
  let scripted = false
  const SCRIPT_MORPH = 1 / 60

  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    pointer = { x: event.clientX, y: event.clientY }
  }

  function onPointerLeave() {
    pointer = null
  }

  function release() {
    if (!aiming) return
    engine.setLook(null, clock, TURN_TIME)
    aiming = false
  }

  function aim() {
    if (!STATE_BY_ID.get(state())?.baseFace) {
      release()
      return
    }
    const box = svg?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return
    if (!aiming) turnSince = clock
    const halfWidth = Math.max(1, window.innerWidth / 2)
    const halfHeight = Math.max(1, window.innerHeight / 2)
    engine.setLook(
      lookTarget({
        nx: pointer ? clamp((pointer.x - (box.left + box.width / 2)) / halfWidth, -1, 1) : 0,
        ny: pointer ? clamp((pointer.y - (box.top + box.height / 2)) / halfHeight, -1, 1) : 0,
        tour: easings.easeOutQuint(clamp((clock - turnSince) / TURN_TIME)),
        pointer: pointer !== null
      }),
      clock
    )
    aiming = true
  }

  function scriptedGaze(run: GazeScript) {
    engine.setLook(run(clock - gazeSince), clock, SCRIPT_MORPH)
  }

  function detach() {
    window.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerleave', onPointerLeave)
  }

  function tick(ms: number) {
    raf = requestAnimationFrame(tick)
    const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0
    last = ms
    clock += dt

    /*
     * L'horloge avance toujours, le dessin non : une image sautee ne fait pas
     * perdre de temps a l'animation, elle la rend seulement moins souvent. La
     * comparaison porte sur l'horloge du bot et pas sur `ms`, pour que la pause
     * automatique ne compte pas comme du retard a rattraper.
     */
    const budget = props.fps && props.fps > 0 ? 1 / props.fps : 0
    if (clock - drawn < budget) return
    drawn = clock

    if (playing()) {
      if (clock >= nextAt && props.cycle.length) goToBlock((block() + 1) % props.cycle.length)
      else setElapsed(clock - blockStart)
    }

    if (props.follow) aim()
    else if (props.gaze) scriptedGaze(props.gaze)
    setFrame(engine.sample(clock))
  }

  function redrawFrozen() {
    if (props.frozenAt === undefined) return
    setFrame(engine.sample(props.frozenAt))
  }

  watch(
      () => props.gaze,
      (run) => {
        if (run) {
          gazeSince = clock
          scripted = true
          engine.setLook(run(0), clock - SCRIPT_MORPH, SCRIPT_MORPH)
        } else if (scripted) {
          engine.setLook(null, clock)
          scripted = false
        }
      }
  )

  watch(block, (index) => {
      apply(index, pendingOffset)
      pendingOffset = 0
    }, { defer: true })

  watch(state, (id) => {
      if (engine.state === id) return
      engine.setState(id, clock)
      redrawFrozen()
    }, { defer: true })

  watch(playing, (on) => {
      if (on) apply(block(), elapsed())
      else nextAt = Infinity
    }, { defer: true })

  watch(
      () => props.cycle,
      (blocks) => {
        if (!blocks.length) {
          nextAt = Infinity
          return
        }
        const index = Math.min(block(), blocks.length - 1)
        if (index !== block()) goToBlock(index)
        else if (blocks[index]!.state !== engine.state) {
          /*
           * Meme bloc, autre etat : le montage a change sous le bot (un avatar qui passe de
           * `idle` a `think`, par exemple). Le bloc repart decale de la date de depart, pour
           * que des bots montes ensemble restent desynchronises apres le changement.
           */
          const offset = start.phase % blocks[index]!.duration
          apply(index, offset, offset)
        } else nextAt = playing() ? blockStart + blocks[index]!.duration : Infinity
      },
      { defer: true }
  )

  watch(shapeRadii, (radii) => {
    engine.setShape(radii, clock)
    redrawFrozen()
  }, { defer: true })

  watch(expression, (value) => {
    engine.setExpression(value, clock)
    redrawFrozen()
  }, { defer: true })

  watch(() => props.frozenAt, redrawFrozen, { defer: true })

  createEffect(
    () => props.follow && props.frozenAt === undefined,
    (following) => {
    if (following) {
      window.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerleave', onPointerLeave)
    } else {
      detach()
      release()
    }
    }
  )

  /*
   * La boucle demarre avec `last = 0` : la premiere image d'une reprise a donc un
   * `dt` nul, ce qui interdit le saut qu'un `ms` vieux de plusieurs secondes
   * provoquerait.
   */
  function run() {
    if (raf || typeof requestAnimationFrame === 'undefined') return
    last = 0
    raf = requestAnimationFrame(tick)
  }

  function halt() {
    if (!raf) return
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf)
    raf = 0
  }

  const [onscreen, setOnscreen] = createSignal(true)
  const [shown, setShown] = createSignal(true)
  const [mounted, setMounted] = createSignal(false)

  /*
   * Un seul endroit decide si la boucle tourne, et il ne demarre jamais avant le
   * montage : `apply` doit avoir pose l'etat du bloc courant, sinon la premiere
   * image morphe depuis `idle`.
   */
  createEffect(
    () =>
      mounted() &&
      props.frozenAt === undefined &&
      (!props.autoPause || (onscreen() && shown())),
    (awake) => {
      if (awake) run()
      else halt()
    }
  )

  onSettled(() => {
    rawProps.ref?.({ get svg() { return svg }, seek, renderAt })
    if (props.frozenAt !== undefined) return
    apply(block(), elapsed())

    const sync = () => setShown(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', sync)
    sync()

    /*
     * `IntersectionObserver` couvre les deux facons de ne pas etre a l'ecran : le
     * defilement, et un ancetre non rendu — un panneau replie ne « croise » rien.
     * Absent de l'environnement (happy-dom, vieux moteur), on considere le bot
     * visible : la bride est une economie, jamais une condition d'affichage.
     */
    const spy =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            const latest = entries[entries.length - 1]
            if (latest) setOnscreen(latest.isIntersecting)
          })
    spy?.observe(svg)
    setMounted(true)

    return () => {
      document.removeEventListener('visibilitychange', sync)
      spy?.disconnect()
    }
  })

  onCleanup(() => {
    halt()
    if (typeof window !== 'undefined') detach()
  })

  function dotAttrs(dot: BotFrame['dots'][number]) {
    const fill =
      dot.color ? pigment(dot.color) : (dot.depth === undefined ? ink() : mixHex(props.paper, ink(), dot.depth))
    const common = { fill, opacity: dot.opacity }
    return dot.d
      ? {
          ...common,
          d: dot.d,
          transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`
        }
      : { ...common, cx: dot.x, cy: dot.y, r: dot.r }
  }

  function pigment(color: string) {
    return paperEnabled() ? mixHex(color, '#B8AE96', 0.25) : color
  }

  /*
   * `keyed={false}` et non l'appariement par defaut : le moteur rend un TABLEAU
   * NEUF a chaque image, donc l'identite d'objet detruisait et recreait les noeuds
   * SVG a chaque image. Sans clef l'appariement se fait par POSITION : les noeuds
   * vivent, seuls leurs attributs bougent. Mesure sur deux avatars de 46 px a
   * 60 Hz : environ 1300 noeuds vivants avant, une quinzaine apres. C'est de
   * l'allocation et du ramasse-miettes en moins, pas du temps de mise en page :
   * le cout d'une image dessinee ne change pas, c'est le role de `fps`.
   * L'ordre du document est le meme, ce dont depend `matricesDesYeux`.
   */
  const Dots = () => (
    <For each={frame().dots} keyed={false}>
      {(dot) => (
        <g>
          <Show when={paperEnabled() && paperBacking()}>
            <g transform="translate(2 2.5)"><Dynamic component={dot().d ? 'path' : 'circle'} {...dotAttrs(dot())} fill="#D9CEB6" /></g>
          </Show>
          <Dynamic component={dot().d ? 'path' : 'circle'} {...dotAttrs(dot())} stroke={paperEnabled() ? '#59604D' : 'none'} stroke-opacity="0.12" stroke-width="0.5" vector-effect="non-scaling-stroke" />
        </g>
      )}
    </For>
  )

  return (
    <svg
      ref={svg}
      width={props.size}
      height={props.size}
      viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`}
      role="img"
      aria-label={props.ariaLabel}
      class={props.class}
      style={props.style}
    >
      <defs>
        <filter id={grainId} x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.76 0.59" numOctaves="3" seed="12" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={-DEMI_VIEWBOX}
          y={-DEMI_VIEWBOX}
          width={DEMI_VIEWBOX * 2}
          height={DEMI_VIEWBOX * 2}
        >
          <path d={frame().bodyPath} fill="#fff" />
          <For each={frame().eyes} keyed={false}>
            {(eye) => <path d={eye().d} transform={eye().matrix} opacity={eye().alpha} fill="#000" />}
          </For>
          <Show when={frame().notch}>
            {(notch) => <circle cx={notch().x} cy={notch().y} r={notch().r} fill="#000" />}
          </Show>
        </mask>

        <For each={frame().arcs} keyed={false}>
          {(arc) => (
            <linearGradient
              id={`${uid}-${arc().id}`}
              gradientUnits="userSpaceOnUse"
              x1={arc().grad.x1}
              y1={arc().grad.y1}
              x2={arc().grad.x2}
              y2={arc().grad.y2}
            >
              <For each={arc().grad.stops} keyed={false}>
                {(color, index) => (
                  <stop offset={index / (arc().grad.stops.length - 1)} stop-color={pigment(color())} />
                )}
              </For>
            </linearGradient>
          )}
        </For>
      </defs>

      <g fill="none" stroke-linecap="round">
        <For each={frame().arcs} keyed={false}>
          {(arc) => (
            <path
              d={arc().back}
              stroke={`url(#${uid}-${arc().id})`}
              stroke-width={arc().width}
              opacity={arc().opacity}
            />
          )}
        </For>
      </g>

      <Show when={frame().dotsBehind}><g><Dots /></g></Show>

      <g opacity={frame().bodyAlpha}>
        <Show when={paperEnabled() && paperBacking()}>
          <path d={frame().bodyPath} transform="translate(4.5 5.5) rotate(-3)" fill="#E6DDC8" stroke="#CFC4AB" stroke-width="0.65" />
        </Show>
        <path d={frame().bodyPath} fill={eyeColor()} />
        <g mask={`url(#${maskId})`}>
          <rect
            x={-DEMI_VIEWBOX}
            y={-DEMI_VIEWBOX}
            width={DEMI_VIEWBOX * 2}
            height={DEMI_VIEWBOX * 2}
            fill={ink()}
          />
          <Show when={paperEnabled() && paperGrain() > 0}>
            <rect x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2} filter={`url(#${grainId})`} opacity={paperGrain()} style={{ 'mix-blend-mode': 'soft-light' }} />
          </Show>
        </g>
        <Show when={paperEnabled()}><path d={frame().bodyPath} fill="none" stroke="#414A3C" stroke-opacity="0.16" stroke-width="0.75" /></Show>
      </g>

      <Show when={!frame().dotsBehind}><g><Dots /></g></Show>

      <Show when={frame().notif}>
        {(notif) => <circle cx={notif().x} cy={notif().y} r={notif().r} fill={NOTIF_BLUE} />}
      </Show>

      <g fill="none" stroke-linecap="round">
        <For each={frame().arcs} keyed={false}>
          {(arc) => (
            <path
              d={arc().front}
              stroke={`url(#${uid}-${arc().id})`}
              stroke-width={arc().width}
              opacity={arc().opacity}
            />
          )}
        </For>
      </g>
    </svg>
  )
}
