// Discreet line under each assistant answer (LKA-22): how long the turn took and
// what it cost, both as the CLI's `result` event reported them (see ChatSession).
import type { ChatTurnMeta } from '@shared/chat'

const seconds = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "0,8 s", "12 s", "2 min 05 s", "1 h 02 min". */
export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 9.95) return `${seconds.format(Math.round(s * 10) / 10)} s`
  const total = Math.round(s)
  if (total < 60) return `${total} s`
  if (total < 3600) return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`
  const min = Math.floor(total / 60)
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}

/** "US$ 0,04"; below one cent: "< US$ 0,01". */
export function formatCost(value: number): string {
  return value < 0.005 ? `< ${usd.format(0.01)}` : usd.format(value)
}

/** "12 s · US$ 0,04", only with the parts the turn has; null when it has none (old turns). */
export function formatTurnMeta(meta: ChatTurnMeta | undefined): string | null {
  const parts: string[] = []
  if (meta?.durationMs != null && meta.durationMs > 0) parts.push(formatDuration(meta.durationMs))
  if (meta?.costUsd != null && meta.costUsd > 0) parts.push(formatCost(meta.costUsd))
  return parts.length ? parts.join(' · ') : null
}
