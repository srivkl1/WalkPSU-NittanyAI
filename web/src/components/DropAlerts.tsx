import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { DROP_TYPES } from '../lib/campus'
import { distanceM } from '../lib/geo'
import { useDrops } from '../lib/hooks'
import { usePresence } from '../session/presence'
import { useReadySession } from '../session/session'

/** Toast only drops worth walking to: roughly a ten-minute walk. Display-only, not a game rule. */
const NEARBY_M = 800

/** Toasts each drop that appears while the app is open. Drops already live when it loads stay quiet. */
function DropAlerts() {
  const { data: drops } = useDrops()
  const { position } = usePresence()
  const { player } = useReadySession()
  const navigate = useNavigate()
  const placeholder = useRef(drops)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    // The first render holds the hook's empty placeholder, not a real load.
    if (drops === placeholder.current) return
    if (seen.current === null) {
      seen.current = new Set(drops.map((d) => d.id))
      return
    }
    for (const drop of drops) {
      if (seen.current.has(drop.id)) continue
      seen.current.add(drop.id)
      if (drop.created_by === player.id) continue // my own meetup: I know
      const c = position?.coords
      const distance = c ? distanceM(c.latitude, c.longitude, drop.lat, drop.lng) : null
      if (distance !== null && distance > NEARBY_M) continue
      const what = drop.type === 'meetup' ? 'meetup' : 'drop'
      toast(distance === null ? `New ${what} on campus` : `New ${what} nearby`, {
        id: `drop-${drop.id}`,
        description: [drop.title, drop.type === 'meetup' ? drop.subtitle : DROP_TYPES[drop.type].label, distance !== null && `${Math.round(distance)} m away`]
          .filter(Boolean)
          .join(' · '),
        action: { label: 'View', onClick: () => navigate('/') },
      })
    }
  }, [drops, position, navigate, player.id])

  return null
}

export default DropAlerts
