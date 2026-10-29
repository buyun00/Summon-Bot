import { createRoot, createSignal, type Accessor } from 'solid-js'
import { ecris, lis } from './stockage'

let enabled!: Accessor<boolean>
let backing!: Accessor<boolean>
let grain!: Accessor<number>
let updateEnabled!: (value: boolean) => void
let updateBacking!: (value: boolean) => void
let updateGrain!: (value: number) => void

createRoot(() => {
  const storedGrain = Number(lis('papier-grain') ?? 0.15)
  ;[enabled, updateEnabled] = createSignal(lis('papier') !== 'off')
  ;[backing, updateBacking] = createSignal(lis('papier-dos') !== 'off')
  ;[grain, updateGrain] = createSignal(Number.isFinite(storedGrain) ? Math.max(0, Math.min(0.35, storedGrain)) : 0.15)
})

export const paperEnabled = enabled
export const paperBacking = backing
export const paperGrain = grain
export function setPaperEnabled(value: boolean) { updateEnabled(value); ecris('papier', value ? 'on' : 'off') }
export function setPaperBacking(value: boolean) { updateBacking(value); ecris('papier-dos', value ? 'on' : 'off') }
export function setPaperGrain(value: number) { const amount = Math.max(0, Math.min(0.35, value)); updateGrain(amount); ecris('papier-grain', String(amount)) }

export function paperEyes(color: string): string {
  const channels = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255)
  const lightness = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  return lightness > 0.69 ? '#485346' : '#FFFBF0'
}
