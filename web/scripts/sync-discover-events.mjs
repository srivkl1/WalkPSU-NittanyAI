// Runs one live sync of Penn State Discover into discover_events, the same as the scheduled /api/sync-events.
// Run from web/ with SUPABASE_SERVICE_ROLE_KEY (and GEMINI_API_KEY, to place events name matching misses) in .env:
//   npm run sync-events
import { createClient } from '@supabase/supabase-js'
import { readBuildings, syncDiscover } from '../api/_discover.ts'

process.loadEnvFile('.env')
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in web/.env')

const summary = await syncDiscover(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), readBuildings(), console.log)
const { placed, gemini, asked } = summary
console.log(`synced ${summary.events} events (${summary.complete ? 'complete' : 'truncated: nothing cancelled'}), ${summary.cancelled} newly cancelled`)
console.log(`placed ${placed.text_or_pin} by name or pin, ${placed.gemini} by Gemini (asked about ${asked} new locations: ${gemini}), ${placed.unplaced} online or off campus`)
console.log(`seeded drops: ${summary.drops_rescheduled} rescheduled, ${summary.drops_closed} closed`)
