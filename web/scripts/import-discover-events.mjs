// Snapshots upcoming public events from Penn State Discover (Campus Labs Engage) and matches each to a campus building.
// Run from web/: npm run import-events   (writes scripts/data/discover-events.json; seed with npm run seed-events)
// The snapshot is what search uses before the first live sync (npm run sync-events, or /api/sync-events on a
// schedule), and what tests run against. Fetching and matching live in api/_discover.ts, shared with the live sync.
// Keeps only public event facts: no descriptions, organizer contacts, or attendee data.
import { mkdir, writeFile } from 'node:fs/promises'
import { fetchDiscover, readBuildings, toEvents } from '../api/_discover.ts'

const OUT = 'scripts/data/discover-events.json'

const { raw } = await fetchDiscover(console.log)
const events = toEvents(raw, readBuildings())

await mkdir('scripts/data', { recursive: true })
await writeFile(OUT, JSON.stringify({ source: 'https://discover.psu.edu/events', fetched_at: new Date().toISOString(), events }, null, 2) + '\n')

const matched = events.filter((e) => e.building)
const by = (how) => matched.filter((e) => e.building.matched_by === how).length
console.log(`wrote ${OUT}: ${events.length} events, ${matched.length} matched (${by('coordinates')} by coordinates, ${by('location text')} by location text), ${events.length - matched.length} skipped`)
