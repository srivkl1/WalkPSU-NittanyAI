import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Drawer } from 'vaul'
import { createMeetup } from '../lib/api'
import { findBuildingAt } from '../lib/buildings'
import type { DropRow } from '../lib/database.types'
import { useBuildings } from '../lib/hooks'
import { usePresence } from '../session/presence'

const DURATIONS = [
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 120, label: '2 hr' },
]
const MAX_LENGTH = 80

type Props = { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (drop: DropRow) => void }

/** Any player pins "volleyball here right now" at their position. A modal sheet: it's a short, focused task. */
function MeetupSheet({ open, onOpenChange, onCreated }: Props) {
  const { position } = usePresence()
  const buildings = useBuildings()
  const [text, setText] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [busy, setBusy] = useState(false)
  const ready = text.trim().length >= 3 && position !== null && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready || !position) return
    const { latitude: lat, longitude: lng } = position.coords
    setBusy(true)
    try {
      const drop = await createMeetup({ text: text.trim(), lat, lng, minutes, buildingNum: findBuildingAt(buildings, lat, lng)?.properties.num ?? null })
      toast.success('Meetup pinned', { description: drop.title })
      setText('')
      onCreated(drop)
    } catch (err) {
      toast.error('Couldn’t pin it', { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="sheet-overlay" />
        <Drawer.Content className="drop-sheet meetup-sheet" aria-describedby={undefined}>
          <Drawer.Handle className="drop-sheet-handle" />
          <form className="stack" onSubmit={submit}>
            <div className="stack-sm">
              <Drawer.Title asChild>
                <h3 className="meetup-title">Start a meetup</h3>
              </Drawer.Title>
              <p className="muted footnote">Pinned where you’re standing so people can find you.</p>
            </div>
            <label className="field">
              What’s happening?
              <input
                className="input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={MAX_LENGTH}
                placeholder="Volleyball on the HUB lawn, come play!"
                enterKeyHint="done"
                autoComplete="off"
              />
              <span className="char-count" aria-live="polite">
                {text.length}/{MAX_LENGTH}
              </span>
            </label>
            <div className="field" role="radiogroup" aria-label="How long">
              How long?
              <div className="segmented">
                {DURATIONS.map((d) => (
                  <button
                    key={d.minutes}
                    type="button"
                    role="radio"
                    aria-checked={minutes === d.minutes}
                    className="segment"
                    onClick={() => setMinutes(d.minutes)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <button className="button primary" disabled={!ready}>
              {busy ? 'Pinning…' : position ? 'Pin it here' : 'Waiting for GPS…'}
            </button>
          </form>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

export default MeetupSheet
