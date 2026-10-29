import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Drawer } from 'vaul'
import { checkInEvent, getGoing, requestOrganizer, setGoing, type EventResult, type Going } from '../lib/api'
import { eventTheme } from '../lib/campus'
import { checkInOpen, eventTime } from '../lib/eventTime'
import { distanceM } from '../lib/geo'
import { useClaimRadius, useMyClubs, useMyEventActivity, useMyProfile } from '../lib/hooks'
import { matchEvent } from '../lib/interests'
import { usePresence } from '../session/presence'
import { useReadySession } from '../session/session'
import { ChartIcon, CheckIcon, ChevronIcon, ClockIcon, PeopleIcon, PinIcon } from './icons'
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
              {checkInOpen(event.starts_at, event.ends_at) && <CheckInRow event={event} />}
              {event.reason && <p className="search-reason">{event.reason}</p>}
              <span className="muted footnote">From Penn State Discover.</span>
              {event.organization && <ClubRow key={event.organization} organization={event.organization} />}
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

/** At the event: check in by GPS at its building (the door's QR code works from anywhere). */
function CheckInRow({ event }: { event: EventResult }) {
  const { position } = usePresence()
  const radius = useClaimRadius()
  const { data: activity } = useMyEventActivity()
  const [busy, setBusy] = useState(false)
  const here = position?.coords
  const distance = here && event.building ? distanceM(here.latitude, here.longitude, event.building.lat, event.building.lng) : null
  const inRange = distance !== null && radius !== null && distance <= radius

  async function checkIn() {
    if (!here) return
    setBusy(true)
    try {
      await checkInEvent(event.id, { lat: here.latitude, lng: here.longitude })
      navigator.vibrate?.(30)
      toast.success('You’re checked in!', { description: event.title })
    } catch (e) {
      toast.error('Couldn’t check in', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (activity.checkedIn.has(event.id)) {
    return (
      <span className="range checked-in" data-in>
        <CheckIcon size={16} />
        You’re checked in
      </span>
    )
  }
  return (
    <div className="stack-sm">
      <button type="button" className="button primary check-in-button" onClick={checkIn} disabled={busy || !inRange}>
        {busy ? 'Checking in…' : 'Check in'}
      </button>
      <span className="muted footnote">
        {!event.building
          ? 'Scan the QR code at the door to check in.'
          : inRange
            ? 'You’re here. The club sees how many came, never who.'
            : distance === null
              ? 'Waiting for GPS… or scan the QR code at the door.'
              : `${Math.round(distance)} m away · get within ${radius ?? '…'} m, or scan the QR code at the door.`}
      </span>
    </div>
  )
}

/** The club behind the event: its dashboard if I run it, otherwise a way to ask an admin for it. */
function ClubRow({ organization }: { organization: string }) {
  const { player } = useReadySession()
  const { data, refresh } = useMyClubs(player.id)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  if (data.clubs.includes(organization)) {
    return (
      <Link className="list-row club-link" to={`/clubs/${encodeURIComponent(organization)}`}>
        <ChartIcon size={20} />
        <span className="list-row-main">
          <strong>{organization}</strong>
          <span className="muted footnote">Open your club’s dashboard</span>
        </span>
        <ChevronIcon className="chevron" />
      </Link>
    )
  }
  if (data.requests.some((r) => r.organization === organization && r.status === 'pending')) {
    return <span className="muted footnote club-pending">You asked to run {organization}. An admin will approve it soon.</span>
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await requestOrganizer(organization, note)
      toast.success('Request sent', { description: `An admin will check that you run ${organization}.` })
      await refresh()
    } catch (err) {
      toast.error('Couldn’t send it', { description: (err as Error).message })
      setBusy(false)
    }
  }

  if (!asking) {
    return (
      <button type="button" className="link-button club-ask" onClick={() => setAsking(true)}>
        Run {organization}? Get its dashboard
      </button>
    )
  }
  return (
    <form className="stack-sm club-ask-form" onSubmit={send}>
      <label className="field">
        Your role (for the admin)
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. President" enterKeyHint="send" autoFocus />
      </label>
      <button className="button primary" disabled={busy}>
        {busy ? 'Sending…' : 'Ask to run this club'}
      </button>
    </form>
  )
}

export default EventSheet
