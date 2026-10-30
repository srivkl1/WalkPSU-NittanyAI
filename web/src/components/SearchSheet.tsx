import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Drawer } from 'vaul'
import { getUpcomingEvents, searchEvents, type EventResult, type SearchAnswer, type SearchableDrop, type UpcomingEvent } from '../lib/api'
import { DROP_TYPES } from '../lib/campus'
import type { DropRow } from '../lib/database.types'
import { eventTime } from '../lib/eventTime'
import { useMyProfile } from '../lib/hooks'
import { forYou, hasProfile } from '../lib/interests'
import { ChevronIcon, SearchIcon } from './icons'

const EXAMPLES = ['free food', 'something for CS majors', 'music tonight']
/** Quick picks for what's on the map. Kept to five so they fit on a phone. */
const CATEGORIES = [
  { label: 'Sports', emoji: '🏀' },
  { label: 'Music', emoji: '🎵' },
  { label: 'Food', emoji: '🍕' },
  { label: 'Arts', emoji: '🎨' },
  { label: 'Games', emoji: '🎮' },
]
const MAX_QUERY = 200
/** Events loaded for "For you" to choose from, and how many of the soonest "Coming up" lists. */
const MAX_UPCOMING = 300
const MAX_COMING_UP = 20

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Live drops as search may see them (titles and building names, never coordinates). */
  drops: SearchableDrop[]
  dropById: (id: string) => DropRow | undefined
  /** Seeded drops (source_id "discover:<event id>"), so a campus event can link to the drop players can claim. */
  dropFor: (eventId: string) => DropRow | undefined
  /** A search finished: the map narrows to the drops that fit. */
  onMatched: (query: string, dropIds: string[]) => void
  onPick: (result: EventResult, drop: DropRow | undefined) => void
  onPickDrop: (drop: DropRow) => void
}

type Status = { kind: 'idle' } | { kind: 'searching' } | ({ kind: 'done' } & SearchAnswer) | { kind: 'error'; message: string }

/**
 * AI search: the drops on the map that fit, and campus events from Penn State Discover. Modal: a short, focused
 * task with the keyboard up.
 */
function SearchSheet({ open, onOpenChange, drops, dropById, dropFor, onMatched, onPick, onPickDrop }: Props) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // The next campus events, to browse before searching. Refreshed each time the sheet opens (the sync runs every
  // 30 minutes); a failed load just leaves the list out.
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([])
  const { data: profile } = useMyProfile()
  // Picked from everything upcoming, not just the soonest few; each says why.
  const picks = useMemo(
    () => forYou(upcoming, profile).map(({ match, ...e }) => ({ ...e, reason: `For you: ${match.reasons.join(', ')}` })),
    [upcoming, profile],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    getUpcomingEvents(MAX_UPCOMING)
      .then((events) => !cancelled && setUpcoming(events))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  async function run(text: string) {
    const q = text.trim()
    if (q.length < 2 || status.kind === 'searching') return
    setQuery(q)
    setStatus({ kind: 'searching' })
    try {
      const answer = await searchEvents(q, drops)
      setStatus({ kind: 'done', ...answer })
      onMatched(q, answer.dropIds)
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message })
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    // Drops the keyboard so the results have the room.
    ;(document.activeElement as HTMLElement | null)?.blur()
    run(query)
  }

  const live = status.kind === 'done' ? status.dropIds.flatMap((id) => dropById(id) ?? []) : []
  // An event already listed above as a live drop isn't repeated below.
  const events = status.kind === 'done' ? status.results.filter((r) => !live.some((d) => d.source_id === `discover:${r.id}`)) : []

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="sheet-overlay" />
        <Drawer.Content className="drop-sheet search-sheet" aria-describedby={undefined}>
          <Drawer.Handle className="drop-sheet-handle" />
          <Drawer.Title className="visually-hidden">Find events</Drawer.Title>
          <form className="search-field" role="search" onSubmit={submit}>
            <SearchIcon size={20} className="muted" />
            <input
              className="search-input"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                // Clearing the field (or its ✕) goes back to the suggestions and the upcoming list.
                if (!e.target.value && status.kind !== 'searching') setStatus({ kind: 'idle' })
              }}
              maxLength={MAX_QUERY}
              placeholder="Find events you’d like…"
              enterKeyHint="search"
              autoComplete="off"
              aria-label="Describe events you’d like"
            />
          </form>

          {status.kind === 'idle' && (
            <div className="stack-sm">
              <span className="muted footnote">Describe what you’re in the mood for. Try:</span>
              <div className="example-chips">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" className="chip example-chip" onClick={() => run(example)}>
                    {example}
                  </button>
                ))}
                {CATEGORIES.map(({ label, emoji }) => (
                  <button key={label} type="button" className="chip example-chip" onClick={() => run(label)}>
                    <span aria-hidden>{emoji}</span> {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {status.kind === 'idle' && upcoming.length > 0 && (
            <div className="search-results">
              {hasProfile(profile) ? (
                picks.length > 0 && (
                  <section className="stack-sm">
                    <h4 className="search-section">For you</h4>
                    <ul className="list">
                      {picks.map((event) => (
                        <EventRow key={event.id} result={event} drop={dropFor(event.id)} onPick={onPick} />
                      ))}
                    </ul>
                  </section>
                )
              ) : (
                <Link className="list-row for-you-nudge" to="/profile">
                  <span className="list-row-main">
                    <strong>Get picks for you</strong>
                    <span className="muted footnote">Add your major and interests in Profile.</span>
                  </span>
                  <ChevronIcon className="chevron" />
                </Link>
              )}
              <section className="stack-sm">
                <h4 className="search-section">Coming up on campus</h4>
                <ul className="list">
                  {upcoming.slice(0, MAX_COMING_UP).map((event) => (
                    <EventRow key={event.id} result={event} drop={dropFor(event.id)} onPick={onPick} />
                  ))}
                </ul>
              </section>
            </div>
          )}

          {status.kind === 'searching' && (
            <div className="search-status" role="status">
              <span className="spinner" aria-hidden />
              <span className="muted">Searching the map and campus events…</span>
            </div>
          )}

          {status.kind === 'error' && (
            <div className="search-status" role="alert">
              <span className="error">{status.message}</span>
              <button type="button" className="button" onClick={() => run(query)}>
                Try again
              </button>
            </div>
          )}

          {status.kind === 'done' &&
            (live.length === 0 && events.length === 0 ? (
              <div className="search-status">
                <strong>Nothing matched — try something broader</strong>
                <span className="muted footnote">Like “food”, “sports”, or “anything tonight”.</span>
              </div>
            ) : (
              <div className="search-results">
                {status.mode === 'keyword' && (
                  <p className="muted footnote search-mode-note">AI search is unavailable right now, so these are keyword matches.</p>
                )}
                {live.length > 0 && (
                  <section className="stack-sm">
                    <h4 className="search-section">Live on the map</h4>
                    <ul className="list">
                      {live.map((drop) => (
                        <li key={drop.id}>
                          <button type="button" className="list-row search-result" onClick={() => onPickDrop(drop)}>
                            <span className="list-row-main">
                              <strong className="search-result-title">{drop.title}</strong>
                              {drop.subtitle && <span className="muted footnote truncate">{drop.subtitle}</span>}
                              <span className="chip search-drop-chip" style={{ '--player': DROP_TYPES[drop.type]?.color } as CSSProperties}>
                                <span className="color-dot" aria-hidden />
                                {DROP_TYPES[drop.type]?.label ?? 'Drop'}
                              </span>
                            </span>
                            <ChevronIcon className="chevron" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {events.length > 0 && (
                  <section className="stack-sm">
                    <h4 className="search-section">Campus events</h4>
                    <ul className="list">
                      {events.map((result) => (
                        <EventRow key={result.id} result={result} drop={dropFor(result.id)} onPick={onPick} />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            ))}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** A campus event: a search result (with Gemini's reason) or an upcoming one. */
function EventRow({ result, drop, onPick }: { result: EventResult; drop: DropRow | undefined; onPick: Props['onPick'] }) {
  return (
    <li>
      <button type="button" className="list-row search-result" onClick={() => onPick(result, drop)}>
        <span className="list-row-main">
          <strong className="search-result-title">{result.title}</strong>
          {result.organization && <span className="muted footnote truncate">{result.organization}</span>}
          <span className="footnote search-result-meta">
            {eventTime(result.starts_at, result.ends_at)} · {result.building?.name ?? result.location ?? 'Location TBA'}
          </span>
          {result.reason && <span className="search-reason footnote">{result.reason}</span>}
          {drop && <span className="chip claimable-chip">Check in here</span>}
        </span>
        <ChevronIcon className="chevron" />
      </button>
    </li>
  )
}

export default SearchSheet
