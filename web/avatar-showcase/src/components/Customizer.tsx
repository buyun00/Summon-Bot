import { For } from 'solid-js'
import BotTile from './BotTile'
import { EXPRESSIONS } from '@/bot/expressions'
import { COLORS, SHAPES } from '@/bot/skins'
import { t } from '@/i18n'

export interface CustomizerProps {
  shape: string
  color: string
  expression: string
  onShapeChange: (value: string) => void
  onColorChange: (value: string) => void
  onExpressionChange: (value: string) => void
}

const PREVIEW_AT = 1

export default function Customizer(props: CustomizerProps) {
  return (
    <div>
      <h2 class="text-sm font-semibold">{t('panel.shape')}</h2>
      <div class="mt-2 grid grid-cols-4 gap-1.5">
        <For each={SHAPES}>
          {(shape) => (
            <BotTile
              label={t(`shapes.${shape.id}`)}
              selected={shape.id === props.shape}
              shape={shape.id}
              color={props.color}
              expression={props.expression}
              frozenAt={PREVIEW_AT}
              onClick={() => props.onShapeChange(shape.id)}
            />
          )}
        </For>
      </div>

      <h2 class="mt-5 text-sm font-semibold">{t('panel.expression')}</h2>
      <div class="mt-2 grid grid-cols-4 gap-1.5">
        <For each={EXPRESSIONS}>
          {(expression) => (
            <BotTile
              label={t(`expressions.${expression.id}`)}
              selected={expression.id === props.expression}
              shape={props.shape}
              color={props.color}
              expression={expression.id}
              frozenAt={PREVIEW_AT}
              onClick={() => props.onExpressionChange(expression.id)}
            />
          )}
        </For>
      </div>

      <h2 class="mt-5 text-sm font-semibold">{t('panel.color')}</h2>
      <div class="mt-2 grid grid-cols-6 gap-1.5">
        <For each={COLORS}>
          {(color) => (
            <button
              type="button"
              class={`flex aspect-square cursor-pointer items-center justify-center rounded-full border-2 transition ${
                color.id === props.color
                  ? 'border-[var(--ink)]'
                  : 'border-transparent hover:border-[var(--line)]'
              }`}
              aria-label={t(`colors.${color.id}`)}
              aria-pressed={color.id === props.color ? 'true' : 'false'}
              onClick={() => props.onColorChange(color.id)}
            >
              <span
                class="block h-[78%] w-[78%] rounded-full ring-1 ring-black/10 ring-inset"
                style={{ background: color.hex }}
              />
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
