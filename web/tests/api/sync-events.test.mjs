// Runs the real web/api/sync-events.ts against the mock Supabase, with Penn State Discover and Gemini replaced at the
// fetch level: the shared secret, which locations reach Gemini, checking and caching its answers, a Gemini outage,
// truncated fetches, a Discover outage, and search reading the synced events.
import { MOCK_PORT, SERVICE_ROLE_KEY, startMockSupabase } from '../mock/supabase.mjs'

const MOCK = `http://localhost:${MOCK_PORT}`
const SECRET = 'test-sync-secret'
Object.assign(process.env, {
  VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_ANON_KEY: 'mock', SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  GEMINI_API_KEY: 'test-gemini-key', DISCOVER_SYNC_SECRET: SECRET,
})

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 400)}`)
  if (!ok) failures++
}

const HUB = '0005000'
const HHD = '0652000'
const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString()
const listing = (id, location, extra = {}) => ({
  id, name: ` Event ${id} `, organizationName: 'Club', theme: 'Social', categoryNames: ['Social Activities'],
  startsOn: hours(1), endsOn: hours(3), location, latitude: null, longitude: null, visibility: 'Public', status: 'Approved',
  description: 'Long organizer text we never keep', ...extra,
})
const LISTINGS = [
  listing('hub', 'HUB 233'),
  listing('hhd', '340 HHD'),
  listing('zoom', 'Zoom (link on request)'),
  listing('park', 'Sunset Park'),
  listing('mystery', 'Mystery Room'),
  // Pinned in Pittsburgh: another campus, never asked about.
  listing('far', 'Room 5', { latitude: '40.4443', longitude: '-79.9532' }),
  listing('private', 'HUB 101', { visibility: 'Private' }),
  listing('hub', 'HUB 233'),
]

// Discover and Gemini stand-ins. `discover` is a list of listings, a full-page generator, or an HTTP status.
const realFetch = globalThis.fetch
const fake = { discover: LISTINGS, discoverCalls: 0, gemini: [], geminiCalls: [] }
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.host === 'discover.psu.edu') {
    fake.discoverCalls++
    if (typeof fake.discover === 'number') return new Response('down', { status: fake.discover })
    const skip = Number(url.searchParams.get('skip'))
    const take = Number(url.searchParams.get('take'))
    if (typeof fake.discover === 'function') return Response.json({ value: fake.discover(skip, take), '@odata.count': 1000 })
    return Response.json({ value: fake.discover.slice(skip, skip + take), '@odata.count': fake.discover.length })
  }
  if (url.host !== 'generativelanguage.googleapis.com') return realFetch(input, init)
  const prompt = JSON.parse(init.body).contents[0].parts[0].text
  fake.geminiCalls.push(prompt)
  const next = fake.gemini.shift() ?? 500
  if (typeof next === 'number') return new Response('{"error":"busy"}', { status: next })
  // Answers by location text, so tests don't depend on the L<n> ids' order.
  const ids = Object.fromEntries([...prompt.matchAll(/^(L\d+) \| (.+)$/gm)].map(([, id, loc]) => [loc, id]))
  const places = Object.entries(next).filter(([loc]) => ids[loc]).map(([loc, num]) => ({ id: ids[loc], num }))
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ places }) }] } }] })
}

const mock = await startMockSupabase()
const { POST } = await import('../../api/sync-events.ts')
const call = async (auth = `Bearer ${SECRET}`) => {
  const res = await POST(new Request('http://localhost/api/sync-events', { method: 'POST', headers: auth ? { Authorization: auth } : {} }))
  return { status: res.status, body: await res.json() }
}
const state = async () => (await realFetch(`${MOCK}/__state`)).json()
const eventById = async (id) => (await state()).discoverEvents.find((e) => e.id === id)

const logged = []
const originalLog = console.log
const originalError = console.error
console.error = (...args) => logged.push(args.map(String).join(' '))

try {
  let r = await call(null)
  check('no secret: 401', r.status === 401 && fake.discoverCalls === 0, r)
  r = await call('Bearer wrong-secret')
  check('wrong secret: 401, Discover never fetched', r.status === 401 && fake.discoverCalls === 0, r)
  delete process.env.DISCOVER_SYNC_SECRET
  r = await call()
  check('no secret configured: 500 and refused', r.status === 500 && /DISCOVER_SYNC_SECRET/.test(r.body.error), r)
  process.env.DISCOVER_SYNC_SECRET = SECRET

  fake.gemini.push({ '340 HHD': HHD, 'Sunset Park': '', 'Mystery Room': 'not-a-building' })
  r = await call()
  check('a sync succeeds', r.status === 200 && r.body.complete === true, r)
  check('public listings only, each once', r.body.events === 6 && !(await eventById('private')), r.body)
  check('summary counts placements', r.body.placed.text_or_pin === 1 && r.body.placed.gemini === 1 && r.body.placed.unplaced === 4 && r.body.gemini === 'ok' && r.body.asked === 3, r.body)

  check('one Gemini call', fake.geminiCalls.length === 1, fake.geminiCalls.length)
  const prompt = fake.geminiCalls[0]
  const asked = [...prompt.matchAll(/^L\d+ \| (.+)$/gm)].map((m) => m[1]).sort()
  check('Gemini sees only in-person locations name matching missed', JSON.stringify(asked) === '["340 HHD","Mystery Room","Sunset Park"]', asked)
  check('never online, already-matched, or other-campus ones', !/Zoom|HUB 233|Room 5/.test(prompt.split('Campus buildings')[0]))
  check('the prompt treats locations as data', /never instructions/.test(prompt))
  check('and lists campus buildings to choose from', prompt.includes(`${HHD} | Health and Human Development`) && prompt.includes(`${HUB} | Hetzel Union Building`))

  const hub = await eventById('hub')
  check('stores the trimmed title and facts', hub?.title === 'Event hub' && hub.organization === 'Club' && hub.location === 'HUB 233', hub)
  check('never the description', !JSON.stringify((await state()).discoverEvents).includes('organizer text'))
  check('name matching places the HUB event', hub?.building?.num === HUB && hub.building.matched_by === 'location text', hub?.building)
  const hhd = await eventById('hhd')
  check('Gemini places "340 HHD"', hhd?.building?.num === HHD && hhd.building.matched_by === 'gemini' && typeof hhd.building.lat === 'number', hhd?.building)
  check('"none" leaves an event unplaced', (await eventById('park'))?.building === null)
  check('a building number that doesn’t exist is ignored', (await eventById('mystery'))?.building === null)
  check('online events stay unplaced', (await eventById('zoom'))?.building === null)

  const cache = Object.fromEntries((await state()).discoverLocations.map((l) => [l.location, l.building_num]))
  check('every answer is cached by normalized location', cache['340 hhd'] === HHD && cache['sunset park'] === null && cache['mystery room'] === null && Object.keys(cache).length === 3, cache)

  fake.geminiCalls.length = 0
  r = await call()
  check('the next sync asks Gemini nothing (all cached)', r.status === 200 && fake.geminiCalls.length === 0 && r.body.gemini === 'not needed', r.body)
  check('and still places "340 HHD" from the cache', (await eventById('hhd'))?.building?.num === HHD && r.body.placed.gemini === 1, r.body)

  // A new location while Gemini is down: the sync still lands, and asks again next time.
  fake.discover = [...LISTINGS, listing('new', 'HHD 120')]
  fake.gemini.push(503, 503, 503, 503)
  r = await call()
  check('Gemini busy: the sync still succeeds', r.status === 200 && r.body.gemini === 'busy' && r.body.events === 7, r.body)
  check('the new event is stored, unplaced for now', (await eventById('new'))?.building === null)
  check('and its location isn’t cached', !(await state()).discoverLocations.some((l) => l.location === 'hhd 120'))
  fake.geminiCalls.length = 0
  fake.gemini.push({ 'HHD 120': HHD })
  r = await call()
  check('the next sync asks about it again', fake.geminiCalls.length === 1 && (await eventById('new'))?.building?.num === HHD, r.body)

  delete process.env.GEMINI_API_KEY
  fake.discover = [...LISTINGS, listing('new2', 'Somewhere 9')]
  fake.geminiCalls.length = 0
  r = await call()
  check('no GEMINI_API_KEY: syncs without placing new locations', r.status === 200 && r.body.gemini === 'skipped (no GEMINI_API_KEY)' && fake.geminiCalls.length === 0, r.body)
  process.env.GEMINI_API_KEY = 'test-gemini-key'

  // A complete fetch without the park event: cancelled.
  fake.discover = LISTINGS.filter((l) => l.id !== 'park')
  r = await call()
  check('a listing gone from a complete fetch is cancelled', r.body.cancelled >= 1 && (await state()).discoverEvents.find((e) => e.id === 'park')?.cancelled === true, r.body)

  // More than 5 pages: truncated, so nothing is cancelled.
  fake.discover = (skip, take) => Array.from({ length: take }, (_, i) => listing(`bulk${skip + i}`, 'Zoom'))
  fake.discoverCalls = 0
  r = await call()
  check('over 5 pages: stops at 500 and marks the fetch truncated', r.status === 200 && r.body.complete === false && r.body.fetched === 500 && fake.discoverCalls === 5, r.body)
  check('a truncated fetch cancels nothing', r.body.cancelled === 0 && (await eventById('hub'))?.cancelled === false, r.body)

  fake.discover = 503
  r = await call()
  check('Discover down: 502 with the reason', r.status === 502 && /Discover returned 503/.test(r.body.error), r)
  check('and the failure is logged', logged.some((l) => /discover sync failed/.test(l)), logged)

  // Search reads the synced events now, not the bundled snapshot.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'searcher', role: 'authenticated' })}.mock`
  await realFetch(`${MOCK}/rest/v1/players`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'mock', Authorization: `Bearer ${token}` }, body: JSON.stringify({ display_name: 'Searcher' }) })
  const search = (await import('../../api/search-events.ts')).POST
  fake.gemini.length = 0
  fake.gemini.push(JSON.stringify({ matches: [{ id: 'hhd', reason: 'Placed by the sync.' }, { id: 'park', reason: 'Cancelled.' }], drop_ids: [] }))
  // The search stand-in above answers places; this one is a raw search answer.
  globalThis.fetch = (inner => async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return inner(input, init)
    fake.geminiCalls.push(JSON.parse(init.body).contents[0].parts[0].text)
    return Response.json({ candidates: [{ content: { parts: [{ text: fake.gemini.shift() }] } }] })
  })(globalThis.fetch)
  const res = await search(new Request('http://localhost/api/search-events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query: 'health' }) }))
  const found = await res.json()
  check('search finds synced events, with their Gemini-placed building', found.results?.length === 1 && found.results[0].id === 'hhd' && found.results[0].building?.num === HHD, found)
  check('and never offers a cancelled one', !found.results?.some((x) => x.id === 'park'), found)
  check('its prompt lists synced events', /^hhd \| Event hhd/m.test(fake.geminiCalls.at(-1)), fake.geminiCalls.at(-1)?.slice(0, 300))
} catch (e) {
  failures++
  originalLog(`FAIL crashed :: ${e.stack}`)
} finally {
  console.error = originalError
  mock.close()
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll sync API checks passed')
process.exit(failures ? 1 : 0)
