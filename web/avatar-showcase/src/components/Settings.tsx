import { For, Show, createMemo } from 'solid-js'
import { langue, LANGUES, setLangue, t } from '@/i18n'

const X = 'https://x.com/worlz_'
const GITHUB = 'https://github.com/jeremy-prt/bloub'

export default function Settings() {
  const credits = createMemo(() => {
    const [before = '', after = ''] = t('settings.credits').split('{name}')
    return { before, after }
  })

  function onKeyboard(event: KeyboardEvent, index: number) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const target = LANGUES[(index + step + LANGUES.length) % LANGUES.length]!
    setLangue(target.id)
    const buttons = (event.currentTarget as HTMLElement).parentElement?.children
    const next = buttons?.[LANGUES.indexOf(target)]
    if (next instanceof HTMLElement) next.focus()
  }

  return (
    <div>
      <h2 class="text-sm font-semibold">{t('settings.language')}</h2>
      <div class="mt-2 flex flex-col gap-1" role="radiogroup" aria-label={t('settings.language')}>
        <For each={LANGUES}>
          {(language, index) => (
            <button type="button" role="radio" aria-checked={language.id === langue() ? 'true' : 'false'} aria-label={language.nom} lang={language.tag} tabindex={language.id === langue() ? 0 : -1} onKeyDown={(event) => onKeyboard(event, index())} class={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-sm transition ${language.id === langue() ? 'border-[var(--ink)] bg-white font-medium' : 'border-[var(--line)] text-[var(--muted)] hover:border-[var(--muted)] hover:text-[var(--ink)]'}`} onClick={() => setLangue(language.id)}>
              <span class="text-base leading-none" aria-hidden="true">{language.emoji}</span>
              <span class="flex-1">{language.nom}</span>
              <Show when={language.id === langue()}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" class="shrink-0"><path d="M2.5 6.4 4.8 8.7 9.5 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg></Show>
            </button>
          )}
        </For>
      </div>
      <h2 class="mt-6 text-sm font-semibold">{t('settings.about')}</h2>
      <a class="mt-2 flex items-center gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-sm transition hover:border-[var(--muted)]" href={GITHUB} target="_blank" rel="noopener noreferrer" aria-label={t('settings.githubAria')}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="shrink-0"><path d="M8 .5a7.5 7.5 0 0 0-2.37 14.62c.37.07.5-.16.5-.36v-1.3c-2.09.46-2.53-.99-2.53-.99-.34-.87-.83-1.1-.83-1.1-.68-.47.05-.46.05-.46.75.06 1.15.78 1.15.78.67 1.15 1.76.82 2.19.63.07-.49.26-.83.48-1.02-1.67-.19-3.42-.83-3.42-3.72 0-.82.29-1.5.78-2.02-.08-.19-.34-.96.07-1.99 0 0 .63-.2 2.06.77a7.1 7.1 0 0 1 3.75 0c1.43-.97 2.06-.77 2.06-.77.41 1.03.15 1.8.07 1.99.49.52.78 1.2.78 2.02 0 2.9-1.76 3.53-3.44 3.71.27.23.51.69.51 1.39v2.06c0 .2.13.44.51.36A7.5 7.5 0 0 0 8 .5z" fill="currentColor" /></svg>
        <span class="flex-1">{t('settings.github')}</span>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" class="shrink-0 text-[var(--muted)]"><path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </a>
      <p class="mt-4 text-xs text-[var(--muted)]">{credits().before}<a class="font-medium text-[var(--ink)] underline decoration-[var(--line)] underline-offset-2 transition hover:decoration-[var(--ink)]" href={X} target="_blank" rel="noopener noreferrer" aria-label={t('settings.creditsAria')}>Jérémy</a>{credits().after}</p>
    </div>
  )
}
