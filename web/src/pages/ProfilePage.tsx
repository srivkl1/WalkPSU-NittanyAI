import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import Avatar from '../components/Avatar'
import { ChevronIcon } from '../components/icons'
import { saveMyProfile, type MyProfile } from '../lib/api'
import { useMyProfile } from '../lib/hooks'
import { INTERESTS, MAJORS } from '../lib/interests'
import { useDiscovery } from '../session/discovery'
import { usePresence } from '../session/presence'
import { useReadySession } from '../session/session'
import { useTrails } from '../session/trail'

const MILE_M = 1609.344

/** "0.42 mi (680 m)" or "1.3 mi (2.1 km)". */
function formatDistance(meters: number) {
  const miles = meters / MILE_M
  const metric = meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`
  return `${miles < 10 ? miles.toFixed(2) : miles.toFixed(1)} mi (${metric})`
}

function ProfilePage() {
  const { player, isAdmin, signOut } = useReadySession()
  const { sharing, setSharing } = usePresence()
  const { segments, distanceM, clearTrail, restoreTrail } = useTrails()
  const { areas, discovered, showFog, setShowFog } = useDiscovery()
  const { data: profile } = useMyProfile()
  const found = areas.filter((id) => discovered.has(id)).length

  function clear() {
    const saved = segments
    clearTrail()
    toast('Trail cleared', { action: { label: 'Undo', onClick: () => restoreTrail(saved) } })
  }

  return (
    <section className="page stack">
      <div className="profile-head">
        <Avatar name={player.display_name} color={player.color} large />
        <h1>{player.display_name}</h1>
        <span className="chip">{isAdmin ? 'Organizer' : 'Player'}</span>
      </div>

      {/* Remounts when the saved profile changes (first load, after saving), so the form starts from it. */}
      <AboutYou key={JSON.stringify(profile)} playerId={player.id} saved={profile} />

      <div className="card explore-card">
        <div className="explore-head">
          <strong>Campus explored</strong>
          <span className="explore-count">
            {found}
            <span className="muted"> / {areas.length || '…'}</span>
          </span>
        </div>
        {areas.length > 0 && <HexMap areas={areas} discovered={discovered} />}
        <span className="muted footnote">Walk into a new part of campus to clear its fog.</span>
      </div>

      <div className="list">
        <div className="list-row">
          <span className="list-row-main">Distance walked today</span>
          <strong className="stat-value">{formatDistance(distanceM)}</strong>
        </div>
        <label className="toggle-row">
          <span className="stack-sm">
            <strong>Show fog of war</strong>
            <span className="muted footnote">Dims the parts of campus you haven’t visited. Discovery keeps counting when it’s off.</span>
          </span>
          <input type="checkbox" className="toggle" checked={showFog} onChange={(e) => setShowFog(e.target.checked)} />
        </label>
        <label className="toggle-row">
          <span className="stack-sm">
            <strong>Show me on the map</strong>
            <span className="muted footnote">Other players see your name and live location while the app is open. It’s never saved.</span>
          </span>
          <input type="checkbox" className="toggle" checked={sharing} onChange={(e) => setSharing(e.target.checked)} />
        </label>
      </div>

      <div className="list">
        <button className="list-row" onClick={clear} disabled={segments.length === 0}>
          <span className="list-row-main">
            Clear my trail
            <span className="muted footnote">Your trail stays on this phone and resets each day.</span>
          </span>
        </button>
        {isAdmin && (
          <Link className="list-row" to="/admin">
            <span className="list-row-main">Admin: drop events</span>
            <ChevronIcon className="chevron" />
          </Link>
        )}
        <button className="list-row error" onClick={signOut}>
          Sign out
        </button>
      </div>
    </section>
  )
}

/** Major and interests, for "For you" event picks. Private to the player. */
function AboutYou({ playerId, saved }: { playerId: string; saved: MyProfile }) {
  const [major, setMajor] = useState(saved.major ?? '')
  const [interests, setInterests] = useState<string[]>(saved.interests)
  const [busy, setBusy] = useState(false)
  const dirty = major.trim() !== (saved.major ?? '') || interests.join() !== saved.interests.join()

  const toggle = (id: string) => setInterests((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]))

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      // Stored in the list's order, so the same picks always compare equal.
      await saveMyProfile(playerId, { major, interests: INTERESTS.map((i) => i.id).filter((id) => interests.includes(id)) })
      toast.success('Saved', { description: 'Your picks are under “For you” in search.' })
    } catch (err) {
      toast.error('Couldn’t save', { description: (err as Error).message })
      setBusy(false)
    }
  }

  return (
    <form className="card about-card stack" onSubmit={save}>
      <div className="stack-sm">
        <strong>About you</strong>
        <span className="muted footnote">Picks campus events for you, using Penn State Discover’s categories. Only you can see this.</span>
      </div>
      <label className="field">
        Major
        <input
          className="input"
          value={major}
          onChange={(e) => setMajor(e.target.value)}
          list="majors"
          maxLength={80}
          placeholder="e.g. Computer Science"
          autoComplete="off"
        />
        <datalist id="majors">
          {MAJORS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <div className="field" role="group" aria-label="Interests">
        Interests
        <div className="interest-chips">
          {INTERESTS.map((i) => (
            <button key={i.id} type="button" className="chip interest-chip" aria-pressed={interests.includes(i.id)} onClick={() => toggle(i.id)}>
              <span aria-hidden>{i.emoji}</span> {i.label}
            </button>
          ))}
        </div>
      </div>
      <button className="button primary" disabled={!dirty || busy}>
        {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
      </button>
    </form>
  )
}

/** Axial "q:r" ids laid out as unit pointy-top hexes, north up (same layout as hexgrid.ts). */
function HexMap({ areas, discovered }: { areas: string[]; discovered: ReadonlySet<string> }) {
  const hexes = useMemo(
    () =>
      areas.map((id) => {
        const [q, r] = id.split(':').map(Number)
        const cx = Math.sqrt(3) * (q + r / 2)
        const cy = -1.5 * r
        const points = Array.from({ length: 6 }, (_, i) => {
          const a = (Math.PI / 180) * (60 * i - 30)
          return `${(cx + Math.cos(a)).toFixed(3)},${(cy - Math.sin(a)).toFixed(3)}`
        }).join(' ')
        return { id, cx, cy, points }
      }),
    [areas],
  )
  const xs = hexes.map((h) => h.cx)
  const ys = hexes.map((h) => h.cy)
  const [x0, x1, y0, y1] = [Math.min(...xs) - 1, Math.max(...xs) + 1, Math.min(...ys) - 1.2, Math.max(...ys) + 1.2]
  const found = areas.filter((id) => discovered.has(id)).length
  return (
    <svg className="hex-map" viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} role="img" aria-label={`${found} of ${areas.length} campus areas explored`}>
      {hexes.map((h) => (
        <polygon key={h.id} points={h.points} className={discovered.has(h.id) ? 'found' : undefined} />
      ))}
    </svg>
  )
}

export default ProfilePage
