import { useEffect, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { Drawer } from 'vaul'
import { getGoing, setGoing, type EventResult, type Going } from '../lib/api'
import { eventTheme } from '../lib/campus'
import { eventTime } from '../lib/eventTime'
import { useMyProfile } from '../lib/hooks'
import { matchEvent } from '../lib/interests'
import { ChevronIcon, ClockIcon, PeopleIcon, PinIcon } from './icons'
import { useNonModalSheet } from './useNonModalSheet'

type Props = {
  event: EventResult | null
  open: boolean
  onClose: () => void
  /** Other upcoming events at the same building, soonest first; tapping one shows it here. */
  more?: EventResult[]
  onSelect?: (event: EventResult) => void
}

/** A campus event's details, after the map flies to its building. Non-modal, like DropSheet. */
function EventSheet({ event, open, onClose, more = [], onSelect }: Props) {
  useNonModalSheet(open)
  const { data: profile } = useMyProfile()
  // Events from the map carry Discover's categories and benefits too; search results match on title and theme.
  const fit = event ? matchEvent(event, profile) : null
  return (
    <Drawer.Root open={open && event !== null} onOpenChange={(next) => !next && onClose()} modal={false}>
      <Drawer.Portal>
        <Drawer.Content className="drop-sheet map-card event-sheet" aria-describedby={undefined} onInteractOutside={(e) => e.preventDefault()}>
          <Drawer.Handle className="drop-sheet-handle" />
          {event && (
            <div className="drop-card">
              <div className="drop-card-head">
                <span className="chip search-drop-chip" style={{ '--player': eventTheme(event.theme).color } as CSSProperties}>
                  <span className="color-dot" aria-hidden />
                  {eventTheme(event.theme).label}
                </span>
                {fit && fit.score > 0 && <span className="chip for-you-chip">★ For you · {fit.reasons.slice(0, 2).join(', ')}</span>}
              </div>
              <div className="drop-card-title">
                <Drawer.Title asChild>
                  <h3>{event.title}</h3>
                </Drawer.Title>
                {event.organization && <p className="drop-subtitle">{event.organization}</p>}
              </div>
              <span className="event-time">
                <ClockIcon size={16} />
                {eventTime(event.starts_at, event.ends_at)}
              </span>
              <span className="range">
                <PinIcon size={16} />
                {event.building ? `${event.building.name}${event.location && event.location !== event.building.name ? ` · ${event.location}` : ''}` : `${event.location ?? 'Location TBA'} · no map pin`}
              </span>
              {/* Keyed by event: switching events ("Also here") starts from a fresh count. */}
              <GoingRow key={event.id} eventId={event.id} />
              {event.reason && <p className="search-reason">{event.reason}</p>}
              <span className="muted footnote">From Penn State Discover. Not a drop, so there are no points here.</span>
              {more.length > 0 && onSelect && (
                <section className="stack-sm event-more">
                  <h4 className="search-section">Also here</h4>
                  <ul className="list">
                    {more.map((other) => (
                      <li key={other.id}>
                        <button type="button" className="list-row search-result" onClick={() => onSelect(other)}>
                          <span className="list-row-main">
                            <strong className="search-result-title">{other.title}</strong>
                            <span className="footnote search-result-meta">{eventTime(other.starts_at, other.ends_at)}</span>
                          </span>
                          <ChevronIcon className="chevron" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** How many players are going (never who), and my "I'm going" toggle. */
function GoingRow({ eventId }: { eventId: string }) {
  const [state, setState] = useState<Going | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getGoing(eventId)
      .then((going) => !cancelled && setState(going))
      .catch(() => !cancelled && setState({ going: 0, me: false }))
    return () => {
      cancelled = true
    }
  }, [eventId])

  async function toggle() {
    if (!state || busy) return
    const before = state
    const me = !state.me
    setBusy(true)
    // Show it right away; the server's count replaces the guess.
    setState({ going: Math.max(0, state.going + (me ? 1 : -1)), me })
    try {
      setState({ going: await setGoing(eventId, me), me })
    } catch (e) {
      setState(before)
      toast.error('Couldn’t update your RSVP', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const others = state ? state.going - (state.me ? 1 : 0) : 0
  const label =
    state === null
      ? 'Checking who’s going…'
      : state.me
        ? others === 0
          ? 'You’re going'
          : `You and ${others} ${others === 1 ? 'other' : 'others'} going`
        : state.going === 0
          ? 'Be the first to go'
          : `${state.going} going`
  return (
    <div className="going">
      <span className="going-count" aria-live="polite">
        <PeopleIcon size={18} />
        {label}
      </span>
      <button type="button" className={`button going-button${state?.me ? '' : ' primary'}`} aria-pressed={!!state?.me} disabled={!state || busy} onClick={toggle}>
        {state?.me ? 'Going ✓' : 'I’m going'}
      </button>
    </div>
  )
}

export default EventSheet
