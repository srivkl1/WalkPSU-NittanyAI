import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ChartIcon, ChevronIcon } from '../components/icons'
import { getClubNames } from '../lib/api'
import { useMyClubs } from '../lib/hooks'
import { useReadySession } from '../session/session'

const clubPath = (organization: string) => `/clubs/${encodeURIComponent(organization)}`

/** The clubs I run, and for admins every club on campus. Each opens its dashboard. */
function ClubsPage() {
  const { player, isAdmin } = useReadySession()
  const { data } = useMyClubs(player.id)
  const pending = data.requests.filter((r) => r.status === 'pending')

  return (
    <section className="page stack">
      <h1>Clubs</h1>
      {data.clubs.length > 0 ? (
        <ul className="list">
          {data.clubs.map((club) => (
            <li key={club}>
              <ClubLink club={club} note="You run this club" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="card muted">
          {isAdmin ? 'You don’t run a club yourself, but as an admin you can open any of them below.' : 'You don’t run a club yet. Open one of its events on the map and tap “Run this club?”.'}
        </p>
      )}
      {pending.length > 0 && (
        <p className="muted footnote">Waiting for an admin: {pending.map((r) => r.organization).join(', ')}</p>
      )}
      {isAdmin && <AllClubs mine={data.clubs} />}
    </section>
  )
}

function ClubLink({ club, note }: { club: string; note?: string }) {
  return (
    <Link className="list-row club-link" to={clubPath(club)}>
      <ChartIcon size={20} />
      <span className="list-row-main">
        <strong className="truncate">{club}</strong>
        {note && <span className="muted footnote">{note}</span>}
      </span>
      <ChevronIcon className="chevron" />
    </Link>
  )
}

/** Admins: every club with an upcoming event, searchable. */
function AllClubs({ mine }: { mine: string[] }) {
  const [clubs, setClubs] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    getClubNames().then(setClubs, () => setClubs([]))
  }, [])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (clubs ?? []).filter((c) => !mine.includes(c) && (!q || c.toLowerCase().includes(q))).slice(0, 50)
  }, [clubs, mine, query])

  return (
    <>
      <h2>Every club</h2>
      <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clubs" enterKeyHint="search" />
      {clubs === null ? (
        <p className="card muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="card muted">No clubs match.</p>
      ) : (
        <ul className="list">
          {shown.map((club) => (
            <li key={club}>
              <ClubLink club={club} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export default ClubsPage
