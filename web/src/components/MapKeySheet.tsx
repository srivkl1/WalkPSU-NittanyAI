import type { CSSProperties, ReactNode } from 'react'
import { Drawer } from 'vaul'
import { DROP_ACCENT, DROP_TYPES, EVENT_THEMES } from '../lib/campus'

type Props = { open: boolean; onOpenChange: (open: boolean) => void }

/** Drop pins, matching MapPage's colors. A found photo hunt turns into a red pin. */
const DROPS = [
  { color: DROP_TYPES.checkin.color, label: 'Check-in', hint: 'Walk there (or scan its QR) for points' },
  { color: DROP_TYPES.minigame.color, label: 'Mini-game', hint: 'Join the lobby, then play for points' },
  { color: DROP_TYPES.photo_hunt.color, label: 'Photo hunt', hint: 'Find the spot in the pink circle' },
  { color: '#dc2626', label: 'Photo hunt, found', hint: 'Later finders get fewer points' },
  { color: DROP_TYPES.meetup.color, label: 'Meetup', hint: 'Players hanging out. No points' },
]

/** What the map's colors mean. Modal: a quick look, then back to the map. */
function MapKeySheet({ open, onOpenChange }: Props) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="sheet-overlay" />
        <Drawer.Content className="drop-sheet map-key-sheet" aria-describedby={undefined}>
          <Drawer.Handle className="drop-sheet-handle" />
          <Drawer.Title asChild>
            <h3 className="meetup-title">Map key</h3>
          </Drawer.Title>
          <div className="map-key-scroll">
            <KeySection title="Campus events" note="From Penn State Discover, this week. A building’s pin takes the color of its next event.">
              {Object.values(EVENT_THEMES).map((t) => (
                <KeyRow key={t.label} swatch={<span className="key-pin" style={{ '--swatch': t.color } as CSSProperties} />} label={t.label} hint={t.hint} />
              ))}
            </KeySection>
            <KeySection title="Game drops" note="Bigger pins, drawn on top of events.">
              {DROPS.map((d) => (
                <KeyRow key={d.label} swatch={<span className="key-pin is-drop" style={{ '--swatch': d.color } as CSSProperties} />} label={d.label} hint={d.hint} />
              ))}
            </KeySection>
            <KeySection title="Buildings">
              <KeyRow swatch={<span className="key-block" style={{ '--swatch': DROP_ACCENT } as CSSProperties} />} label="Glowing orange" hint="A live drop is here, or it’s the event you opened" />
              <KeyRow swatch={<span className="key-block" style={{ '--swatch': '#c9d6ec' } as CSSProperties} />} label="Light blue" hint="Has campus events this week" />
            </KeySection>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function KeySection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="stack-sm">
      <h4 className="search-section">{title}</h4>
      {note && <p className="muted footnote map-key-note">{note}</p>}
      <ul className="map-key-table">{children}</ul>
    </section>
  )
}

function KeyRow({ swatch, label, hint }: { swatch: ReactNode; label: string; hint: string }) {
  return (
    <li className="map-key-row">
      {swatch}
      <strong>{label}</strong>
      <span className="muted footnote">{hint}</span>
    </li>
  )
}

export default MapKeySheet
