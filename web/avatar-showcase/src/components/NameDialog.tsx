import { createSignal } from 'solid-js'
import { on } from '@/solid-compat'
import { t } from '@/i18n'
import { useModalDialog } from '@/ui/useModalDialog'

export default function NameDialog(props: {
  title: string
  label: string
  submitLabel: string
  open: boolean
  value: string
  onOpenChange: (value: boolean) => void
  onSubmit: (name: string) => void
}) {
  const [box, setBox] = createSignal<HTMLDialogElement>()
  const [field, setField] = createSignal<HTMLInputElement>()
  const [draft, setDraft] = createSignal('')
  useModalDialog(() => props.open, box)

  on(() => props.open, (open) => {
    if (!open) return
    setDraft(props.value)
    queueMicrotask(() => field()?.select())
  })

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const clean = draft().trim()
    if (!clean) return field()?.focus()
    props.onSubmit(clean)
    props.onOpenChange(false)
  }

  return (
    <dialog ref={setBox} class="dialogue m-auto w-80 rounded-2xl bg-white p-5 text-[var(--ink)] shadow-xl" aria-label={props.title} onClose={() => props.onOpenChange(false)} onCancel={(event) => { event.preventDefault(); props.onOpenChange(false) }}>
      <form class="flex flex-col gap-4" onSubmit={submit}>
        <h2 class="text-sm font-semibold">{props.title}</h2>
        <label class="flex flex-col gap-1.5 text-xs text-[var(--muted)]">
          {props.label}
          <input ref={setField} value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} class="h-9 rounded-lg bg-black/5 px-2.5 text-sm text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]" type="text" maxlength="40" required />
        </label>
        <div class="flex justify-end gap-2">
          <button type="button" class="h-8 cursor-pointer rounded-lg px-3 text-xs text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--ink)]" onClick={() => props.onOpenChange(false)}>{t('dialog.cancel')}</button>
          <button type="submit" class="h-8 cursor-pointer rounded-lg bg-[var(--ink)] px-3 text-xs text-[var(--paper)] transition hover:opacity-90 active:scale-95">{props.submitLabel}</button>
        </div>
      </form>
    </dialog>
  )
}
