import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ChevronIcon, PinIcon, QrIcon, SparkIcon } from '../components/icons'
import { eventCheckinUrl, getClubInsights, getClubStats, getEventCheckinCode, type ClubInsights } from '../lib/api'
import type { ClubEvent, ClubStats } from '../lib/database.types'
import { eventTime } from '../lib/eventTime'

const suggestedTime = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const pastDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

type Loaded = { stats: ClubStats; upcoming: ClubEvent[]; past: ClubEvent[] }
type Insights = { status: 'loading' } | { status: 'ready'; insights: ClubInsights } | { status: 'failed'; message: string }

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–')

/** A club's numbers for its organizers: who's interested, RSVP'd, checked in, and came back. Counts only. */
function ClubDashboardPage() {
  const organization = decodeURIComponent(useParams().organization ?? '')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [insights, setInsights] = useState<Insights>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    getClubStats(organization).then(
      (stats) => {
        if (cancelled) return
        const now = Date.now()
        const live = stats.events.filter((e) => !e.cancelled)
        setLoaded({
          stats,
          // Soonest first; the server sends newest first.
          upcoming: live.filter((e) => Date.parse(e.ends_at) > now).reverse(),
          past: live.filter((e) => Date.parse(e.ends_at) <= now),
        })
      },
      (e: Error) => !cancelled && setError(e.message),
    )
    getClubInsights(organization).then(
      (result) => !cancelled && setInsights({ status: 'ready', insights: result }),
      (e: Error) => !cancelled && setInsights({ status: 'failed', message: e.message }),
    )
    return () => {
      cancelled = true
    }
  }, [organization])

  if (error) {
    return (
      <section className="page stack">
        <BackLink />
        <h1>{organization}</h1>
        <p className="card error">{error}</p>
      </section>
    )
  }
  if (!loaded) {
    return (
      <section className="page stack">
        <BackLink />
        <h1>{organization}</h1>
        <p className="card muted">Loading…</p>
      </section>
    )
  }

  const { stats, upcoming, past } = loaded
  const ready = insights.status === 'ready' ? insights.insights : null
  return (
    <section className="page stack club-dashboard">
      <BackLink />
      <h1>{organization}</h1>

      <div className="card retention-card">
        <span className="muted footnote">Second-visit rate</span>
        <strong className="retention-rate">{percent(stats.returning, stats.attendees)}</strong>
        <span className="muted">
          {stats.attendees === 0
            ? 'No check-ins yet. Show the door QR code at your next event.'
            : `${stats.returning} of ${stats.attendees} ${stats.attendees === 1 ? 'person who came' : 'people who came'} came back for another event.`}
        </span>
      </div>

      <div className="stat-tiles">
        <Tile label="Interested" value={ready ? ready.interested : insights.status === 'loading' ? '…' : '–'} hint="In upcoming events" />
        <Tile label="RSVP’d" value={stats.rsvps} hint="I’m going" />
        <Tile label="Checked in" value={stats.checkins} hint="At the door" />
        <Tile label="Came back" value={stats.returning} hint="2+ events" />
      </div>

      <Suggestions insights={insights} />

      <h2>Coming up</h2>
      {upcoming.length === 0 ? (
        <p className="card muted">No upcoming events on Penn State Discover.</p>
      ) : (
        <ul className="list">
          {upcoming.map((e) => (
            <UpcomingRow key={e.id} event={e} interested={ready?.interestedByEvent[e.id]} />
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <>
          <h2>Past events</h2>
          <ul className="list">
            {past.map((e) => (
              <li key={e.id} className="list-row club-event">
                <span className="list-row-main">
                  <strong className="truncate">{e.title}</strong>
                  <span className="muted footnote">{pastDay.format(new Date(e.starts_at))}</span>
                </span>
                <span className="club-event-numbers">
                  <span>
                    <strong>{e.checked_in}</strong> came
                  </span>
                  <span className="muted footnote">
                    {e.going} RSVP’d{e.going > 0 && ` · ${percent(Math.min(e.checked_in, e.going), e.going)} showed`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted footnote">Counts only. WalkPSU never shows organizers who is interested, going, or checked in.</p>
    </section>
  )
}

function BackLink() {
  return (
    <Link className="back-row" to="/clubs">
      <ChevronIcon className="back-chevron" size={18} />
      Clubs
    </Link>
  )
}

function Tile({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <div className="stat-tile card">
      <span className="muted footnote">{label}</span>
      <strong className="stat-tile-value">{value}</strong>
      <span className="muted footnote">{hint}</span>
    </div>
  )
}

/** When and where to hold the next event: Gemini's picks, or the server's own from the numbers when Gemini is down. */
function Suggestions({ insights }: { insights: Insights }) {
  return (
    <div className="card suggestions">
      <div className="suggestions-head">
        <SparkIcon size={20} />
        <strong>Next event ideas</strong>
      </div>
      {insights.status === 'loading' && <span className="muted">Looking at your numbers…</span>}
      {insights.status === 'failed' && <span className="muted">{insights.message}</span>}
      {insights.status === 'ready' &&
        (insights.insights.suggestions.length === 0 ? (
          <span className="muted">Not enough to go on yet. Check people in at a couple of events first.</span>
        ) : (
          <>
            <ol className="suggestion-list">
              {insights.insights.suggestions.map((s) => (
                <li key={s.starts_at + (s.building?.num ?? '')} className="suggestion">
                  <strong>{suggestedTime.format(new Date(s.starts_at))}</strong>
                  {s.building && (
                    <span className="suggestion-place">
                      <PinIcon size={14} />
                      {s.building.name}
                    </span>
                  )}
                  <span className="muted footnote">{s.reason}</span>
                </li>
              ))}
            </ol>
            <span className="muted footnote">
              {insights.insights.mode === 'ai' ? 'Suggested by Gemini from your club’s and campus-wide numbers.' : 'AI is unavailable right now, so these come straight from the numbers.'}
            </span>
          </>
        ))}
    </div>
  )
}

/** An upcoming event: its numbers, and the QR code to show at the door. */
function UpcomingRow({ event, interested }: { event: ClubEvent; interested: number | undefined }) {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function toggle() {
    setOpen(!open)
    if (!code)
      getEventCheckinCode(event.id).then(setCode, (e: Error) => setError(e.message))
  }

  return (
    <li className="qr-row">
      <button type="button" className="list-row qr-toggle club-event" onClick={toggle} aria-expanded={open}>
        <span className="list-row-main">
          <strong className="truncate">{event.title}</strong>
          <span className="muted footnote">
            {eventTime(event.starts_at, event.ends_at)}
            {event.building && ` · ${event.building.name}`}
          </span>
          <span className="footnote club-event-counts">
            {interested !== undefined && `${interested} interested · `}
            {event.going} going{event.checked_in > 0 && ` · ${event.checked_in} checked in`}
          </span>
        </span>
        <QrIcon className="muted" size={22} />
      </button>
      {open && (
        <div className="qr-code">
          {code ? (
            <>
              <QRCodeSVG value={eventCheckinUrl(event.id, code)} size={240} marginSize={2} />
              <span className="muted">Show this at the door. Scanning it checks people in, from 30 minutes before the start until the end.</span>
            </>
          ) : (
            <span className="muted">{error ?? 'Loading code…'}</span>
          )}
        </div>
      )}
    </li>
  )
}

export default ClubDashboardPage
