import { pourcentage, t } from '@/i18n'

export default function ZoomSlider(props: {
  zoom: number
  min: number
  max: number
  onZoomChange: (value: number) => void
}) {
  return (
    <div class="flex items-center gap-1.5">
      <span class="h-1 w-1 shrink-0 rounded-full bg-[var(--muted)]" aria-hidden="true" />
      <input
        type="range"
        class="h-1 w-28 cursor-pointer accent-[var(--ink)] max-sm:w-20"
        min={props.min}
        max={props.max}
        step="0.01"
        value={props.zoom}
        aria-label={t('timeline.zoom')}
        aria-valuetext={pourcentage(props.zoom)}
        onInput={(event) => props.onZoomChange(Number(event.currentTarget.value))}
      />
      <span class="h-2 w-2 shrink-0 rounded-full bg-[var(--muted)]" aria-hidden="true" />
      <span class="w-11 text-left text-xs tabular-nums text-[var(--muted)]">
        {pourcentage(props.zoom)}
      </span>
    </div>
  )
}
