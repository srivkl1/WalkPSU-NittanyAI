import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/database.types.ts'
import { readBuildings, syncDiscover } from './_discover.ts'
import { HttpError, env, respond } from './_shared.ts'

// POST /api/sync-events: refreshes discover_events from Penn State Discover (see _discover.ts). Supabase pg_cron calls
// it every 30 minutes with `Authorization: Bearer <DISCOVER_SYNC_SECRET>` (docs/SETUP.md); players can't.

export function POST(request: Request) {
  return respond(() => sync(request))
}

function authorized(request: Request) {
  const expected = Buffer.from(`Bearer ${env('DISCOVER_SYNC_SECRET')}`)
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function sync(request: Request) {
  if (!authorized(request)) throw new HttpError(401, 'Not allowed')
  const asServer = createClient<Database>(env('VITE_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
  try {
    const summary = await syncDiscover(asServer, readBuildings())
    console.log(`discover sync: ${JSON.stringify(summary)}`)
    return summary
  } catch (e) {
    // Discover or the database failed; the next scheduled run tries again. Logged, since no one reads cron's replies.
    console.error(`discover sync failed: ${(e as Error).message}`)
    throw new HttpError(502, (e as Error).message)
  }
}
