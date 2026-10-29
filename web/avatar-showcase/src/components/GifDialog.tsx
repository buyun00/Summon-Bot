import { For, createSignal } from 'solid-js'
import { t } from '@/i18n'
import { FONDS_GIF, type FondGif } from '@/ui/export'
import { useModalDialog } from '@/ui/useModalDialog'

export default function GifDialog(props: {
  open: boolean
  fond: FondGif
  onOpenChange: (value: boolean) => void
  onFondChange: (value: FondGif) => void
  onConfirm: () => void
}) {
  const [box, setBox] = createSignal<HTMLDialogElement>()
  useModalDialog(() => props.open, box)

  function confirm(event: SubmitEvent) {
    event.preventDefault()
    props.onConfirm()
    props.onOpenChange(false)
  }

  return (
    <dialog ref={setBox} class="dialogue m-auto w-80 rounded-2xl bg-white p-5 text-[var(--ink)] shadow-xl" aria-label={t('export.gifTitle')} onClose={() => props.onOpenChange(false)} onCancel={(event) => { event.preventDefault(); props.onOpenChange(false) }}>
      <form class="flex flex-col gap-4" onSubmit={confirm}>
        <div class="flex flex-col gap-1">
          <h2 class="text-sm font-semibold">{t('export.gifTitle')}</h2>
          <p class="text-xs text-[var(--muted)]">{t('export.gifDetail')}</p>
        </div>
        <fieldset class="flex flex-col gap-1">
          <legend class="sr-only">{t('export.gifBackground')}</legend>
          <For each={FONDS_GIF}>
            {(choice, index) => (
              <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition hover:bg-black/5">
                <input type="radio" name="fond" value={choice} checked={choice === props.fond} autofocus={index() === 0} class="accent-[var(--ink)]" onChange={() => props.onFondChange(choice)} />
                <span class="flex flex-col">
                  {t(`export.fond_${choice}`)}
                  <span class="text-xs text-[var(--muted)]">{t(`export.fond_${choice}_aide`)}</span>
                </span>
              </label>
            )}
          </For>
        </fieldset>
        <div class="flex justify-end gap-2">
          <button type="button" class="h-8 cursor-pointer rounded-lg px-3 text-xs text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--ink)]" onClick={() => props.onOpenChange(false)}>{t('dialog.cancel')}</button>
          <button type="submit" class="h-8 cursor-pointer rounded-lg bg-[var(--ink)] px-3 text-xs text-[var(--paper)] transition hover:opacity-90 active:scale-95">{t('export.gifConfirm')}</button>
        </div>
      </form>
    </dialog>
  )
}
