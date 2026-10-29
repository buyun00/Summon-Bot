import { createSignal } from 'solid-js'
import { t } from '@/i18n'
import { useModalDialog } from '@/ui/useModalDialog'

export default function ConfirmDialog(props: {
  title: string
  detail: string
  confirmLabel: string
  open: boolean
  onOpenChange: (value: boolean) => void
  onConfirm: () => void
}) {
  const [box, setBox] = createSignal<HTMLDialogElement>()
  useModalDialog(() => props.open, box)

  function confirm() {
    props.onConfirm()
    props.onOpenChange(false)
  }

  return (
    <dialog
      ref={setBox}
      class="dialogue m-auto w-80 rounded-2xl bg-white p-5 text-[var(--ink)] shadow-xl"
      aria-label={props.title}
      onClose={() => props.onOpenChange(false)}
      onCancel={(event) => {
        event.preventDefault()
        props.onOpenChange(false)
      }}
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <h2 class="text-sm font-semibold">{props.title}</h2>
          <p class="text-xs text-[var(--muted)]">{props.detail}</p>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" autofocus class="h-8 cursor-pointer rounded-lg px-3 text-xs text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--ink)]" onClick={() => props.onOpenChange(false)}>
            {t('dialog.cancel')}
          </button>
          <button type="button" class="h-8 cursor-pointer rounded-lg bg-[var(--danger)] px-3 text-xs text-white transition hover:opacity-90 active:scale-95" onClick={confirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
