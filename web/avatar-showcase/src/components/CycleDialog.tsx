import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { t } from '@/i18n'
import {
  FONDS_GIF,
  FORMATS_CYCLE,
  cycleAccepteTransparence,
  videoPossible,
  type FondGif,
  type FormatCycle
} from '@/ui/export'
import { useModalDialog } from '@/ui/useModalDialog'

export default function CycleDialog(props: {
  avancement: number | null
  erreur: boolean
  open: boolean
  format: FormatCycle
  fond: FondGif
  onOpenChange: (value: boolean) => void
  onFormatChange: (value: FormatCycle) => void
  onFondChange: (value: FondGif) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const [box, setBox] = createSignal<HTMLDialogElement>()
  useModalDialog(() => props.open, box)
  const formats = FORMATS_CYCLE.filter((format) => format !== 'mp4' || videoPossible())
  const busy = () => props.avancement !== null
  const percent = createMemo(() => Math.round((props.avancement ?? 0) * 100))

  createEffect(
    () => props.format,
    (format) => { if (!formats.includes(format)) props.onFormatChange(formats[0]!) }
  )

  function confirm(event: SubmitEvent) {
    event.preventDefault()
    if (!busy()) props.onConfirm()
  }

  function close() {
    if (busy()) props.onCancel()
    props.onOpenChange(false)
  }

  return (
    <dialog ref={setBox} class="dialogue m-auto w-80 rounded-2xl bg-white p-5 text-[var(--ink)] shadow-xl" aria-label={t('timeline.export')} onClose={() => props.onOpenChange(false)} onCancel={(event) => { event.preventDefault(); close() }}>
      <form class="flex flex-col gap-4" onSubmit={confirm}>
        <div class="flex flex-col gap-1">
          <h2 class="text-sm font-semibold">{t('timeline.export')}</h2>
          <p class="text-xs text-[var(--muted)]">{t('export.cycleDetail')}</p>
        </div>
        <fieldset class="flex flex-col gap-1" disabled={busy()}>
          <legend class="sr-only">{t('export.cycleFormat')}</legend>
          <For each={formats}>
            {(choice, index) => (
              <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition hover:bg-black/5">
                <input type="radio" name="format" value={choice} checked={choice === props.format} autofocus={index() === 0} class="accent-[var(--ink)]" onChange={() => props.onFormatChange(choice)} />
                <span class="flex flex-col">
                  {t(`export.cycle_${choice}`)}
                  <span class="text-xs text-[var(--muted)]">{t(`export.cycle_${choice}_aide`)}</span>
                </span>
              </label>
            )}
          </For>
        </fieldset>
        <Show when={cycleAccepteTransparence(props.format)}>
          <fieldset class="flex flex-col gap-1" disabled={busy()}>
            <legend class="sr-only">{t('export.gifBackground')}</legend>
            <For each={FONDS_GIF}>
              {(choice) => (
                <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition hover:bg-black/5">
                  <input type="radio" name="fondCycle" value={choice} checked={choice === props.fond} class="accent-[var(--ink)]" onChange={() => props.onFondChange(choice)} />
                  {t(`export.fond_${choice}`)}
                </label>
              )}
            </For>
          </fieldset>
        </Show>
        <Show when={props.erreur && !busy()}><p class="text-xs text-[var(--danger)]" role="alert">{t('export.failed')}</p></Show>
        <Show
          when={busy()}
          fallback={
            <div class="flex justify-end gap-2">
              <button type="button" class="h-8 cursor-pointer rounded-lg px-3 text-xs text-[var(--muted)] transition hover:bg-black/5" onClick={close}>{t('dialog.cancel')}</button>
              <button type="submit" class="h-8 cursor-pointer rounded-lg bg-[var(--ink)] px-3 text-xs text-[var(--paper)] transition hover:opacity-90 active:scale-95">{props.erreur ? t('export.cycleReessayer') : t('export.gifConfirm')}</button>
            </div>
          }
        >
          <div class="flex flex-col gap-1.5">
            <div class="h-1.5 overflow-hidden rounded-full bg-black/10"><div class="h-full rounded-full bg-[var(--ink)]" style={{ width: `${percent()}%` }} /></div>
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs tabular-nums text-[var(--muted)]">{t('export.cycleProgress')} {percent()} %</p>
              <button type="button" class="h-7 cursor-pointer rounded-lg px-2 text-xs text-[var(--muted)] transition hover:bg-black/5" onClick={close}>{t('dialog.cancel')}</button>
            </div>
          </div>
        </Show>
      </form>
    </dialog>
  )
}
