// Runs the real web/api/club-insights.ts against the mock Supabase, with Gemini replaced at the fetch level: who may
// ask, interest counts (RSVPs plus profile matches, counts only), Gemini's suggestions checked and cleaned, and the
// numbers-only fallback when Gemini is out or unconfigured. Gemini never sees anything about a player.
import { MOCK_PORT, SERVICE_ROLE_KEY, startMockSupabase } from '../mock/supabase.mjs'

const MOCK = `http://localhost:${MOCK_PORT}`
Object.assign(process.env, { VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_ANON_KEY: 'mock', SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY, GEMINI_API_KEY: 'test-gemini-key' })

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 400)}`)
  if (!ok) failures++
}

// Gemini stand-in: answers from a queue (an object, raw text, or an HTTP status) and records each prompt.
const realFetch = globalThis.fetch
const gemini = { queue: [], calls: [] }
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init)
  gemini.calls.push(JSON.parse(init.body).contents[0].parts[0].text)
  const next = gemini.queue.shift() ?? 500
  if (next === 402) return Response.json({ error: { code: 402, status: 'RESOURCE_EXHAUSTED' } }, { status: 402 })
  if (typeof next === 'number') return new Response('{"error":"busy"}', { status: next })
  return Response.json({ candidates: [{ content: { parts: [{ text: typeof next === 'string' ? next : JSON.stringify(next) }] } }] })
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const tokenFor = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated' })}.mock`
const call = async (path, body, sub, service = false) =>
  realFetch(`${MOCK}/rest/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: 'mock', Authorization: `Bearer ${service ? SERVICE_ROLE_KEY : tokenFor(sub)}` },
    body: JSON.stringify(body),
  })

const mock = await startMockSupabase()
const { POST } = await import('../../api/club-insights.ts')
async function insights(organization, sub = 'organizer') {
  const headers = { 'Content-Type': 'application/json', ...(sub && { Authorization: `Bearer ${tokenFor(sub)}` }) }
  const res = await POST(new Request('http://localhost/api/club-insights', { method: 'POST', headers, body: JSON.stringify({ organization }) }))
  return { status: res.status, body: await res.json() }
}

const DAY = 86_400_000
const at = (days, hours = 0) => new Date(Date.now() + days * DAY + hours * 3600_000).toISOString()
const OSMOND = { num: '0401000', name: 'Osmond Laboratory (I Thornton)', lat: 40.79846, lng: -77.862438, matched_by: 'location text' }
const event = (id, title, starts, building = OSMOND, extra = {}) => ({
  id, title, organization: 'Chess Club', theme: 'Social', categories: [], benefits: [], starts_at: starts, ends_at: new Date(Date.parse(starts) + 2 * 3600_000).toISOString(),
  location: building?.name ?? 'Zoom', building, ...extra,
})

try {
  // Players: the organizer (admin in the mock), and two players with profiles.
  await call('players', { display_name: 'Org' }, 'organizer')
  await call('players', { display_name: 'Foodie' }, 'foodie')
  await call('players', { display_name: 'Learner' }, 'learner')
  await call('player_profiles', { major: null, interests: ['free_food'] }, 'foodie')
  await call('player_profiles', { major: 'Philosophy', interests: ['academic'] }, 'learner')
  await call('rpc/sync_discover_events', {
    p_complete: true,
    p_events: [
      event('past', 'Chess Night', at(-7)),
      event('soon', 'Chess Night II', at(3), OSMOND, { benefits: ['Free Food'] }),
      event('later', 'Chess Strategy Lecture', at(5), null, { theme: 'ThoughtfulLearning' }),
      { ...event('other', 'Go Tournament', at(3)), organization: 'Go Club' },
    ],
  }, null, true)
  await call('rpc/set_going', { p_event_id: 'later', p_going: true }, 'bot0')
  await call('rpc/set_going', { p_event_id: 'soon', p_going: true }, 'foodie')
  const { players, eventCheckins } = mock.db
  for (const p of players.slice(0, 3)) eventCheckins.push({ event_id: 'past', player_id: p.id, created_at: at(-7) })

  let r = await insights('Chess Club', null)
  check('no token: 401', r.status === 401, r)
  r = await insights('', 'organizer')
  check('no club: 400', r.status === 400, r)
  r = await insights('Chess Club', 'rival')
  check('a player who doesn’t run the club is refused before anything is read', r.status === 403 && /Only this club/.test(r.body.error) && gemini.calls.length === 0, r)

  // Gemini answers: one good pick, plus a bad weekday, an off-list hour, a duplicate day, and an unknown building.
  gemini.queue.push({
    suggestions: [
      { weekday: 'Thursday', hour: 19, building_num: '0401000', reason: '  Your Thursday nights   drew the most.  ' },
      { weekday: 'Funday', hour: 19, building_num: '', reason: 'x' },
      { weekday: 'Monday', hour: 3, building_num: '', reason: 'x' },
      { weekday: 'Thursday', hour: 18, building_num: '', reason: 'duplicate day' },
      { weekday: 'Tuesday', hour: 18, building_num: '9999999', reason: 'Tuesdays are quiet.' },
    ],
  })
  r = await insights('Chess Club')
  check('an organizer gets insights', r.status === 200, r)
  // soon: foodie (RSVP and Free Food). later: bot0 (RSVP) and learner (Learning theme matches "academic").
  check('interested per event: RSVPs plus profile matches', r.body.interestedByEvent?.soon === 1 && r.body.interestedByEvent?.later === 2, r.body)
  check('and each player once across the club', r.body.interested === 3, r.body)
  check('only upcoming events, only this club', !('past' in (r.body.interestedByEvent ?? {})) && !('other' in (r.body.interestedByEvent ?? {})), r.body)
  check('Gemini’s valid picks are used', r.body.mode === 'ai' && r.body.suggestions.length === 2, r.body)
  const [first, second] = r.body.suggestions ?? []
  check('a pick becomes a real date and the building’s map name', new Date(first.starts_at).getDay() >= 0 && Date.parse(first.starts_at) > Date.now() && first.building?.name === OSMOND.name, first)
  check('its reason is cleaned up', first?.reason === 'Your Thursday nights drew the most.', first)
  check('an unknown building is dropped, the pick kept', second?.building === null && second.reason === 'Tuesdays are quiet.', second)
  const prompt = gemini.calls.at(-1)
  check('Gemini sees the club’s events and counts', prompt.includes('3 checked in | Chess Night\n') && /3 players on the app are interested/.test(prompt), prompt)
  check('but nothing about any player', !/Foodie|Learner|Philosophy|free_food|organizer/.test(prompt) && !players.some((p) => prompt.includes(p.id)), prompt)
  check('nor other clubs’ event titles', !/Go Tournament/.test(prompt), prompt)

  gemini.queue.push({ suggestions: [{ weekday: 'Nope', hour: 19, building_num: '', reason: 'x' }] })
  r = await insights('Chess Club')
  check('when no pick survives, the numbers decide', r.status === 200 && r.body.mode === 'stats' && r.body.suggestions.length === 3, r.body)

  gemini.queue.push(402)
  r = await insights('Chess Club')
  check('Gemini out of credits: suggestions from the numbers', r.status === 200 && r.body.mode === 'stats' && r.body.suggestions.length > 0 && r.body.interested === 3, r.body)
  check('which cite the club’s own history', /averaged 3 check-ins/.test(r.body.suggestions.map((s) => s.reason).join(' ')), r.body.suggestions)

  gemini.queue.push('not json')
  r = await insights('Chess Club')
  check('a garbled answer falls back too', r.status === 200 && r.body.mode === 'stats', r.body)

  delete process.env.GEMINI_API_KEY
  const calls = gemini.calls.length
  r = await insights('Chess Club')
  check('no Gemini key: no call, numbers only', r.status === 200 && r.body.mode === 'stats' && gemini.calls.length === calls, r.body)
} finally {
  mock.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll club-insights API checks passed')
process.exit(failures ? 1 : 0)
