import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { Drawer } from 'vaul'
import { claimDrop, closeDrop } from '../lib/api'
import { DROP_TYPES } from '../lib/campus'
import type { DropRow } from '../lib/database.types'
import { useReadySession } from '../session/session'
import { eventTime } from '../lib/eventTime'
import { ClockIcon, PinIcon } from './icons'
import { useNonModalSheet } from './useNonModalSheet'

type Props = {
  drop: DropRow | null
  open: boolean
  distance: number | null
  radius: number | null
  position: GeolocationPosition | null
  onClose: () => void
  onCheckedIn: () => void
  /** The drop was cleared from the map (an admin, or the player who started a meetup). */
  onCleared: () => void
}

/** A drop's details in a bottom sheet the player can drag away. Non-modal, so the map stays live behind it. */
function DropSheet({ drop, open, onClose, onCleared, ...card }: Props) {
  useNonModalSheet(open)

  return (
    <Drawer.Root open={open && drop !== null} onOpenChange={(next) => !next && onClose()} modal={false}>
      <Drawer.Portal>
        <Drawer.Content
          className="drop-sheet map-card"
          aria-describedby={undefined}
          // Map taps decide for themselves: another marker swaps the sheet, empty map closes it.
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Drawer.Handle className="drop-sheet-handle" />
          {drop && <DropCard drop={drop} {...card} />}
          {drop && <ClearDrop key={drop.id} drop={drop} onCleared={onCleared} />}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

type CardProps = Omit<Props, 'drop' | 'open' | 'onClose' | 'onCleared'> & { drop: DropRow }

function DropCard({ drop, distance, radius, position, onCheckedIn }: CardProps) {
  const [busy, setBusy] = useState(false)
  const inRange = radius !== null && distance !== null && distance <= radius

  async function checkIn() {
    if (!position) return
    setBusy(true)
    try {
      await claimDrop(drop.id, { lat: position.coords.latitude, lng: position.coords.longitude })
      navigator.vibrate?.(30)
      toast.success('You’re checked in!', { description: drop.title })
      onCheckedIn()
    } catch (e) {
      toast.error('Couldn’t check in', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const meetup = drop.type === 'meetup'
  const range =
    distance === null
      ? 'Waiting for GPS…'
      : inRange
        ? meetup
          ? 'You’re here!'
          : 'You’re here. Check in!'
        : meetup
          ? `${Math.round(distance)} m away`
          : `${Math.round(distance)} m away · get within ${radius ?? '…'} m`

  return (
    <div className="drop-card">
      <div className="drop-card-head">
        <span className="chip" style={{ '--player': DROP_TYPES[drop.type].color } as CSSProperties}>
          <span className="color-dot" aria-hidden />
          {DROP_TYPES[drop.type].label}
        </span>
      </div>
      <div className="drop-card-title">
        <Drawer.Title asChild>
          <h3>{drop.title}</h3>
        </Drawer.Title>
        {drop.subtitle && <p className="drop-subtitle">{drop.subtitle}</p>}
      </div>
      {drop.starts_at && drop.expires_at && (
        <span className="event-time">
          <ClockIcon size={16} />
          {eventTime(drop.starts_at, drop.expires_at)}
        </span>
      )}
      {drop.hint_photo_url && <img className="hint-photo" src={drop.hint_photo_url} alt="Hint" />}
      <span className="range" data-in={inRange || undefined}>
        <PinIcon size={16} />
        {range}
      </span>
      {meetup ? (
        <span className="muted footnote">A player started this. Nothing to check in to, just people: go say hi.</span>
      ) : (
        <>
          <button className="button primary" onClick={checkIn} disabled={busy || !inRange}>
            {busy ? 'Checking in…' : 'Check in'}
          </button>
          <span className="muted footnote">Indoors? Scan the drop’s QR code to check in from anywhere.</span>
        </>
      )}
    </div>
  )
}

/**
 * Takes a drop off the map: admins for any drop, players for a meetup they started. It can't be undone, so the
 * first tap arms it and a second tap within a few seconds confirms.
 */
function ClearDrop({ drop, onCleared }: { drop: DropRow; onCleared: () => void }) {
  const { player, isAdmin } = useReadySession()
  const mine = drop.type === 'meetup' && drop.created_by === player.id
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(disarm.current ?? undefined), [])
  if (!isAdmin && !mine) return null

  async function clear() {
    if (!armed) {
      setArmed(true)
      disarm.current = setTimeout(() => setArmed(false), 3000)
      return
    }
    setBusy(true)
    try {
      await closeDrop(drop.id)
      toast(mine ? 'Meetup ended' : 'Drop cleared', { description: drop.title })
      onCleared()
    } catch (e) {
      toast.error('Couldn’t clear it', { description: (e as Error).message })
      setBusy(false)
      setArmed(false)
    }
  }

  const label = mine ? 'End meetup' : 'Clear from map'
  return (
    <button className="button danger clear-drop" onClick={clear} disabled={busy} data-armed={armed || undefined}>
      {busy ? 'Clearing…' : armed ? `Tap again to ${label.toLowerCase()}` : label}
    </button>
  )
}

export default DropSheet
