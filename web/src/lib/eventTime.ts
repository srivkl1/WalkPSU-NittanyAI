const timeRange = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/** "Happening now · until 9:00 PM", "Today · 7:00 – 9:00 PM", or "Tue, Oct 27 · 7:00 – 9:00 PM". */
export function eventTime(startsAt: string, endsAt: string) {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  const now = new Date()
  if (start <= now) return `Happening now · until ${timeRange.format(end)}`
  const day = start.toDateString() === now.toDateString() ? 'Today' : dayLabel.format(start)
  return `${day} · ${timeRange.formatRange(start, end)}`
}

/** How early check-in opens. Mirrors check_in_event() in 20261029010000_clubs.sql. */
export const CHECK_IN_EARLY_MS = 30 * 60_000

/** Whether an event takes check-ins right now: from 30 minutes before it starts until it ends. */
export function checkInOpen(startsAt: string, endsAt: string) {
  const now = Date.now()
  return now >= Date.parse(startsAt) - CHECK_IN_EARLY_MS && now <= Date.parse(endsAt)
}
