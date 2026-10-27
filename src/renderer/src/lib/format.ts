const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

/** "agora", "há 5 minutos", "ontem"... falls back to a date after a week. */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.round((ts - now) / 1000)
  const abs = Math.abs(diff)
  if (abs < 45) return 'agora'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), 'day')
  return dtf.format(ts)
}

export function fullDate(ts: number): string {
  return dtf.format(ts)
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}
