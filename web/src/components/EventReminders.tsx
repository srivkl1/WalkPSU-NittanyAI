import { useMemo, useState, useSyncExternalStore } from 'react'
import type { UpcomingEvent } from '../lib/api'
import { useMyEventActivity, useMyProfile } from '../lib/hooks'
import { forYou } from '../lib/interests'
import { BellIcon, CrossIcon } from './icons'

/** How soon before an event starts its reminder shows. It stays up until the event ends or is dismissed. */
const REMIND_BEFORE_MS = 60 * 60_000
const DISMISSED_KEY = 'walkpsu:dismissed-reminders'

// One shared clock that ticks every 30 s, so "Starts in 12 min" stays current without a timer per component.
let now = Date.now()
const clock = {
  subscribe(onTick: () => void) {
    const timer = setInterval(() => {
      now = Date.now()
      onTick()
    }, 30_000)
    return () => clearInterval(timer)
  },
  get: () => now,
}

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
  } catch {
    return []
  }
}

function startsIn(event: UpcomingEvent, at: number) {
  const ms = Date.parse(event.starts_at) - at
  if (ms <= 0) return 'Happening now'
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return `Starts in ${minutes} min`
}

/**
 * Top left of the map: a reminder when an event I'm going to, or one of my "For you" picks, is about to start or is
 * on now. Worked out on the phone from my RSVPs and profile; nothing is sent anywhere.
 */
function EventReminders({ events, onShow }: { events: UpcomingEvent[]; onShow: (event: UpcomingEvent) => void }) {
  const at = useSyncExternalStore(clock.subscribe, clock.get)
  const { data: activity } = useMyEventActivity()
  const { data: profile } = useMyProfile()
  const [dismissed, setDismissed] = useState(readDismissed)

  const due = useMemo(() => {
    const picks = new Set(forYou(events, profile).map((e) => e.id))
    return events.filter(
      (e) =>
        (activity.going.has(e.id) || picks.has(e.id)) &&
        !activity.checkedIn.has(e.id) &&
        !dismissed.includes(e.id) &&
        Date.parse(e.starts_at) - at <= REMIND_BEFORE_MS &&
        Date.parse(e.ends_at) > at,
    )
  }, [events, profile, activity, dismissed, at])

  const event = due[0]
  if (!event) return null

  function dismiss() {
    // Only ids of events still on the list are kept, so the stored list never grows past a week's worth.
    const next = [...dismissed.filter((id) => events.some((e) => e.id === id)), event.id]
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // Private mode: it's dismissed until the page reloads.
    }
  }

  const why = activity.going.has(event.id) ? 'You’re going' : 'For you'
  return (
    <div className="reminder glass" role="status">
      <button type="button" className="reminder-main" onClick={() => onShow(event)}>
        <span className="reminder-icon" aria-hidden>
          <BellIcon size={18} />
        </span>
        <span className="reminder-text">
          <span className="reminder-when">
            {startsIn(event, at)} · {why}
          </span>
          <strong className="truncate">{event.title}</strong>
          {event.building && <span className="muted footnote truncate">{event.building.name}</span>}
        </span>
      </button>
      {due.length > 1 && <span className="reminder-more">+{due.length - 1}</span>}
      <button type="button" className="reminder-close" aria-label="Dismiss reminder" onClick={dismiss}>
        <CrossIcon size={14} />
      </button>
    </div>
  )
}

export default EventReminders
