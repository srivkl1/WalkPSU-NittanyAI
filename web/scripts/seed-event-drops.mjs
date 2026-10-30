// Seeds 12 check-in drops (one per building, spread over campus, starting soonest) from the Penn State Discover snapshot (npm run import-events writes it).
// Run from web/ with SUPABASE_SERVICE_ROLE_KEY in .env (never VITE_-prefixed; it bypasses RLS):
//   npm run seed-events               pick and insert
//   npm run seed-events -- --dry-run  show the picks, write nothing
//   npm run seed-events -- --clear    delete every drop this script created (and their check-ins)
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { CAMPUS_CENTER } from '../src/lib/campus.ts'
import { distanceM } from '../src/lib/geo.ts'

const SNAPSHOT = 'scripts/data/discover-events.json'
const SOURCE = 'discover:'
const COUNT = 12
const WINDOW_MS = 48 * 3600_000
const MAX_WINDOW_MS = 7 * 24 * 3600_000
// We demo from ECoRE, so its drops would be checked in to without walking anywhere.
const EXCLUDED_BUILDINGS = new Set(['0310000'])
// Walkable from the middle of campus; Discover also lists events at the farms, the airport and downtown hotels.
const MAX_FROM_CENTER_M = 2000
// Multi-week exhibits would sit on the map for days.
const MAX_DURATION_MS = 12 * 3600_000

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')

function client() {
  process.loadEnvFile('.env')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in web/.env')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message)
  return data
}

if (args.has('--clear')) {
  const removed = unwrap(await client().from('drops').delete().like('source_id', `${SOURCE}%`).select('title'))
  console.log(`cleared ${removed.length} imported drops`)
  process.exit(0)
}

const { events, fetched_at } = JSON.parse(await readFile(SNAPSHOT, 'utf8'))
const now = Date.now()
const eligible = events
  .filter((e) => e.building && !EXCLUDED_BUILDINGS.has(e.building.num))
  .filter((e) => distanceM(e.building.lat, e.building.lng, CAMPUS_CENTER[0], CAMPUS_CENTER[1]) <= MAX_FROM_CENTER_M)
  .filter((e) => Date.parse(e.ends_at) > now && Date.parse(e.ends_at) - Date.parse(e.starts_at) <= MAX_DURATION_MS)
  .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))

// The next 48 hours, widened a day at a time (up to a week) when that window has fewer than 12 buildings, e.g. a weekend.
let windowMs = WINDOW_MS
const within = (ms) => eligible.filter((e) => Date.parse(e.starts_at) < now + ms)
while (windowMs < MAX_WINDOW_MS && new Set(within(windowMs).map((e) => e.building.num)).size < COUNT) windowMs += 24 * 3600_000
const candidates = within(windowMs)

// Discover's theme is the closest thing it exposes to an organization type (Arts, Athletics, Cultural, Social, ...).
const kind = (e) => e.theme ?? e.categories[0] ?? 'Other'

/**
 * Greedy spread: each pick is the event farthest from the buildings already picked, minus a penalty per earlier pick
 * of the same kind, so the 12 land on different parts of campus with a mix of clubs. One drop per building.
 */
function pick() {
  const picked = []
  const usedBuildings = new Set()
  while (picked.length < COUNT) {
    let best = null
    for (const e of candidates) {
      if (usedBuildings.has(e.building.num)) continue
      const spread = picked.length
        ? Math.min(...picked.map((p) => distanceM(p.building.lat, p.building.lng, e.building.lat, e.building.lng)))
        : 0
      const score = Math.min(spread, 700) - 350 * picked.filter((p) => kind(p) === kind(e)).length
      if (!best || score > best.score) best = { e, score }
    }
    if (!best) break
    picked.push(best.e)
    usedBuildings.add(best.e.building.num)
  }
  return picked
}

const picks = pick()
const when = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
console.log(`snapshot from ${fetched_at}: ${candidates.length} events in the next ${windowMs / 3600_000} h at walkable buildings; picked ${picks.length}`)
for (const e of picks) console.log(`  ${when(e.starts_at).padEnd(14)} ${kind(e).padEnd(18)} ${e.building.name}: ${e.title} (${e.organization})`)
if (picks.length < COUNT) console.log(`only ${picks.length} events qualify; run npm run import-events for a fresher snapshot`)
if (dryRun) process.exit(0)

const supabase = client()
const { count, error } = await supabase.from('drops').select('id', { count: 'exact', head: true }).like('source_id', `${SOURCE}%`)
if (error) throw new Error(error.message)
if (count) {
  console.error(`${count} imported drops already exist. Run npm run seed-events -- --clear first.`)
  process.exit(1)
}

const rows = picks.map((e) => ({
  title: e.title,
  subtitle: e.organization,
  type: 'checkin',
  lat: e.building.lat,
  lng: e.building.lng,
  building_num: e.building.num,
  starts_at: e.starts_at,
  expires_at: e.ends_at,
  source_id: `${SOURCE}${e.id}`,
}))
const inserted = unwrap(await supabase.from('drops').insert(rows).select('id'))
console.log(`inserted ${inserted.length} check-in drops`)
