// In-memory stand-in for the Supabase REST/auth/RPC endpoints the app uses, for UI tests without a real project.
// It mirrors the SQL rules closely enough to drive the screens (60 m check-in radius, QR codes, event check-ins, club
// organizers and stats) but it is not the source of truth: tests/sql checks the real functions. No Realtime: the
// app's refresh() and polling fallbacks keep screens current, exactly as on flaky venue Wi-Fi.
//
//   node tests/mock/supabase.mjs            # serves on :54321
//   VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=mock npm run dev
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const MOCK_PORT = 54321
export const OLD_MAIN_LAWN = { lat: 40.7982, lng: -77.8599 }
const RADIUS_M = 60
/** Stands in for the service_role key: only requests carrying it may call service-only functions and tables. */
export const SERVICE_ROLE_KEY = 'mock-service-role'
const CHECK_IN_EARLY_MS = 30 * 60_000
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4']

const R = 6371000
const rad = (d) => (d * Math.PI) / 180
const distance = (a, b, c, d) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2))
const now = () => new Date().toISOString()

function seed() {
  const players = [{ id: 'rival', auth_id: 'rival', display_name: 'Rival <b>Ray</b>', color: PALETTE[0], is_admin: false, created_at: now() }]
  for (const [i, name] of ['Bot Ana', 'Bot Ben', 'Bot Cal'].entries()) {
    players.push({ id: `bot${i}`, auth_id: `bot${i}`, display_name: name, color: PALETTE[i + 1], is_admin: false, created_at: now() })
  }
  const drop = (id, title, type, lat, lng, building_num, extra = {}) => ({
    id, title, type, lat, lng, points: 10, status: 'active', hint_photo_url: null, building_num, created_by: null, created_at: now(), expires_at: null,
    subtitle: null, starts_at: null, source_id: null, ...extra,
  })
  const drops = [
    // Shaped like a drop seeded from a Penn State Discover event, so the card shows its organization and time.
    drop('center-drop', 'Old Main lawn', 'checkin', OLD_MAIN_LAWN.lat, OLD_MAIN_LAWN.lng, null, {
      subtitle: 'Penn State Outing Club',
      starts_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 90 * 60_000).toISOString(),
      source_id: 'discover:mock',
    }),
    // ~30 m east of the lawn drop, at the HUB (so the map highlights building 0005000).
    drop('hub-drop', 'HUB check-in', 'checkin', OLD_MAIN_LAWN.lat, OLD_MAIN_LAWN.lng + 30 / (111_195 * Math.cos(rad(OLD_MAIN_LAWN.lat))), '0005000'),
    // A check-in seeded from a Discover event (source_id), so AI search results can link to it. Open ground ~400 m
    // southwest, so it highlights no building.
    drop('event-drop', 'Lawn Picnic', 'checkin', OLD_MAIN_LAWN.lat - 280 / 111_195, OLD_MAIN_LAWN.lng - 280 / (111_195 * Math.cos(rad(OLD_MAIN_LAWN.lat))), null, {
      subtitle: 'Penn State Picnic Club',
      starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      source_id: 'discover:e2e-linked',
    }),
  ]
  return {
    players,
    drops,
    claims: [],
    discovered: [],
    searchQuota: new Map(),
    discoverEvents: [],
    discoverLocations: [],
    eventRsvps: [],
    eventCheckins: [],
    eventSecrets: [],
    organizers: [],
    requests: [],
    profiles: [],
    secrets: drops.map((d) => ({ drop_id: d.id, claim_code: `${d.id}-code` })),
    log: [],
  }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.mock`
const subFrom = (req) => {
  try {
    return JSON.parse(Buffer.from((req.headers.authorization ?? '').split(' ')[1].split('.')[1], 'base64url')).sub
  } catch {
    return null
  }
}

const compare = (a, b) => {
  const [x, y] = [Date.parse(a), Date.parse(b)]
  return Number.isNaN(x) || Number.isNaN(y) ? Number(a) - Number(b) : x - y
}
/** The PostgREST filters the app sends: `eq.`, `in.(…)`, `gt.`, `lt.`. Ordering, `or=`, and `select=` are ignored. */
const filterRows = (rows, params) =>
  rows.filter((row) =>
    [...params].every(([k, v]) => {
      if (!(k in row)) return true
      if (v.startsWith('eq.')) return String(row[k]) === v.slice(3)
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(row[k]))
      if (v.startsWith('gt.')) return compare(row[k], v.slice(3)) > 0
      if (v.startsWith('lt.')) return compare(row[k], v.slice(3)) < 0
      return true
    }),
  )

export function startMockSupabase({ port = MOCK_PORT } = {}) {
  const db = seed()
  const { players, drops, claims, discovered, searchQuota, discoverEvents, discoverLocations, eventRsvps, eventCheckins, eventSecrets, organizers, requests, profiles, secrets, log } = db
  const proofOk = (json, drop) =>
    json.p_code != null
      ? json.p_code === secrets.find((s) => s.drop_id === drop.id)?.claim_code
      : json.p_lat != null && distance(json.p_lat, json.p_lng, drop.lat, drop.lng) <= RADIUS_M
  const runsClub = (me, organization) => !!me && (me.is_admin || organizers.some((o) => o.organization === organization && o.player_id === me.id))
  const checkIn = (eventId, playerId) => {
    if (eventCheckins.some((c) => c.event_id === eventId && c.player_id === playerId)) return false
    eventCheckins.push({ event_id: eventId, player_id: playerId, created_at: now() })
    return true
  }
  const serviceOnly = (fn) => (json, me, req) =>
    req.headers.authorization === `Bearer ${SERVICE_ROLE_KEY}` ? fn(json) : [403, { message: 'permission denied for function' }]

  const rpc = {
    // Simplified sync_discover_events: replaces events by id and, on a complete fetch, cancels upcoming ones not sent.
    // tests/sql/discover-sync.test.mjs covers the real function (drops following their event included).
    sync_discover_events: serviceOnly(({ p_events, p_complete }) => {
      const sent = new Set(p_events.map((e) => e.id))
      let cancelled = 0
      for (const e of discoverEvents) {
        if (p_complete && !e.cancelled && !sent.has(e.id) && Date.parse(e.ends_at) > Date.now()) {
          e.cancelled = true
          cancelled++
        }
      }
      for (const e of p_events) {
        const at = discoverEvents.findIndex((x) => x.id === e.id)
        const next = { categories: [], benefits: [], ...e, cancelled: false, synced_at: now() }
        if (at >= 0) discoverEvents[at] = next
        else discoverEvents.push(next)
      }
      return [200, { events: p_events.length, cancelled, drops_rescheduled: 0, drops_closed: 0 }]
    }),
    // Counts only, never who (as in 20261028010000_event_rsvps.sql).
    event_going: ({ p_event_ids }, me) => [
      200,
      discoverEvents
        .filter((e) => p_event_ids.includes(e.id))
        .map((e) => {
          const going = eventRsvps.filter((r) => r.event_id === e.id)
          return { event_id: e.id, going: going.length, me: going.some((r) => r.player_id === me?.id) }
        }),
    ],
    set_going: ({ p_event_id, p_going }, me) => {
      if (!me) return [400, { message: 'Join the game before RSVPing' }]
      const event = discoverEvents.find((e) => e.id === p_event_id)
      if (!event) return [400, { message: 'Event not found' }]
      const mine = eventRsvps.findIndex((r) => r.event_id === p_event_id && r.player_id === me.id)
      if (p_going) {
        if (event.cancelled) return [400, { message: 'This event was cancelled' }]
        if (Date.parse(event.ends_at) <= Date.now()) return [400, { message: 'This event is over' }]
        if (mine < 0) eventRsvps.push({ event_id: p_event_id, player_id: me.id, created_at: now() })
      } else if (mine >= 0) eventRsvps.splice(mine, 1)
      return [200, eventRsvps.filter((r) => r.event_id === p_event_id).length]
    },
    // As in 20261029010000_clubs.sql.
    check_in_event: (json, me) => {
      if (!me) return [400, { message: 'Join before checking in' }]
      const event = discoverEvents.find((e) => e.id === json.p_event_id)
      if (!event) return [400, { message: 'Event not found' }]
      if (event.cancelled) return [400, { message: 'This event was cancelled' }]
      if (Date.now() < Date.parse(event.starts_at) - CHECK_IN_EARLY_MS) return [400, { message: 'Check-in opens 30 minutes before the event' }]
      if (Date.now() > Date.parse(event.ends_at)) return [400, { message: 'This event is over' }]
      if (json.p_code != null) {
        if (eventSecrets.find((s) => s.event_id === event.id)?.code !== json.p_code) return [400, { message: "That QR code doesn't match this event" }]
      } else if (!event.building) return [400, { message: "Scan the event's QR code to check in" }]
      else if (json.p_lat == null) return [400, { message: "Location unavailable. Scan the event's QR code instead" }]
      else if (distance(json.p_lat, json.p_lng, event.building.lat, event.building.lng) > RADIUS_M) return [400, { message: "Get closer to the building, or scan the event's QR code" }]
      return [200, checkIn(event.id, me.id)]
    },
    event_checkin_code: (json, me) => {
      const event = discoverEvents.find((e) => e.id === json.p_event_id)
      if (!event) return [400, { message: 'Event not found' }]
      if (!runsClub(me, event.organization)) return [400, { message: "Only this club's organizers can show its check-in code" }]
      if (!eventSecrets.some((s) => s.event_id === event.id)) eventSecrets.push({ event_id: event.id, code: randomUUID().replaceAll('-', '') })
      return [200, eventSecrets.find((s) => s.event_id === event.id).code]
    },
    request_organizer: (json, me) => {
      if (!me) return [400, { message: 'Join before asking to run a club' }]
      if (!discoverEvents.some((e) => e.organization === json.p_organization)) return [400, { message: 'Club not found' }]
      if (organizers.some((o) => o.organization === json.p_organization && o.player_id === me.id)) return [400, { message: 'You already run this club' }]
      const waiting = requests.find((r) => r.organization === json.p_organization && r.player_id === me.id && r.status === 'pending')
      if (waiting) return [200, waiting]
      const request = { id: randomUUID(), organization: json.p_organization, player_id: me.id, note: String(json.p_note ?? '').trim() || null, status: 'pending', created_at: now(), decided_at: null }
      requests.push(request)
      return [200, request]
    },
    decide_organizer_request: (json, me) => {
      if (!me?.is_admin) return [400, { message: 'Only admins can approve organizers' }]
      const request = requests.find((r) => r.id === json.p_request_id && r.status === 'pending')
      if (!request) return [400, { message: 'That request was already answered' }]
      Object.assign(request, { status: json.p_approve ? 'approved' : 'declined', decided_at: now() })
      if (json.p_approve && !organizers.some((o) => o.organization === request.organization && o.player_id === request.player_id)) {
        organizers.push({ organization: request.organization, player_id: request.player_id, approved_at: now() })
      }
      return [200, request]
    },
    club_stats: (json, me) => {
      const org = json.p_organization
      if (!runsClub(me, org)) return [400, { message: "Only this club's organizers can see its dashboard" }]
      const events = discoverEvents.filter((e) => e.organization === org && Date.parse(e.ends_at) > Date.now() - 90 * 86_400_000)
      const ids = new Set(discoverEvents.filter((e) => e.organization === org).map((e) => e.id))
      const visits = new Map()
      for (const c of eventCheckins) if (ids.has(c.event_id)) visits.set(c.player_id, (visits.get(c.player_id) ?? 0) + 1)
      return [
        200,
        {
          organization: org,
          events: events
            .sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at))
            .map((e) => ({
              id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, cancelled: e.cancelled, location: e.location, building: e.building,
              going: eventRsvps.filter((r) => r.event_id === e.id).length,
              checked_in: eventCheckins.filter((c) => c.event_id === e.id).length,
            })),
          attendees: visits.size,
          returning: [...visits.values()].filter((n) => n >= 2).length,
          rsvps: eventRsvps.filter((r) => ids.has(r.event_id)).length,
          checkins: eventCheckins.filter((c) => ids.has(c.event_id)).length,
        },
      ]
    },
    claim_radius_m: () => [200, RADIUS_M],
    current_player_id: (json, me) => [200, me?.id ?? null],
    use_search_quota: (json, me) => {
      if (!me) return [400, { message: 'Join the game before searching' }]
      const q = searchQuota.get(me.id)
      const fresh = !q || Date.now() - q.windowStart > 10 * 60_000
      const next = fresh ? { windowStart: Date.now(), used: 1 } : { ...q, used: q.used + 1 }
      searchQuota.set(me.id, next)
      return [200, next.used <= 10]
    },
    create_meetup: (json, me) => {
      if (!me) return [400, { message: 'Join the game before posting a meetup' }]
      const text = String(json.p_text ?? '').trim()
      if (text.length < 3 || text.length > 80) return [400, { message: "Say what's happening in 3 to 80 characters" }]
      if (json.p_lat == null || json.p_lng == null) return [400, { message: 'Turn on location to post a meetup' }]
      for (const d of drops) if (d.created_by === me.id && d.type === 'meetup' && d.status === 'active') d.status = 'expired'
      const minutes = Math.min(Math.max(json.p_minutes ?? 60, 15), 180)
      const d = {
        id: randomUUID(), title: text, subtitle: `Started by ${me.display_name}`, type: 'meetup', lat: json.p_lat, lng: json.p_lng, points: 1,
        status: 'active', hint_photo_url: null, building_num: json.p_building_num ?? null, created_by: me.id, created_at: now(), starts_at: now(),
        expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), source_id: null,
      }
      drops.push(d)
      secrets.push({ drop_id: d.id, claim_code: randomUUID().replaceAll('-', '') })
      return [200, d]
    },
    close_drop: (json, me) => {
      const drop = drops.find((d) => d.id === json.p_drop_id)
      if (!drop) return [400, { message: 'Drop not found' }]
      if (!(me?.is_admin || (drop.type === 'meetup' && drop.created_by === me?.id))) return [400, { message: 'Only admins can clear drops' }]
      drop.status = 'expired'
      return [200, null]
    },
    discover_area: (json, me) => {
      if (!me) return [400, { message: 'Join the game before discovering areas' }]
      if (!/^-?\d{1,4}:-?\d{1,4}$/.test(json.p_hex_id)) return [400, { message: 'violates check constraint' }]
      if (discovered.some((d) => d.player_id === me.id && d.hex_id === json.p_hex_id)) return [200, false]
      discovered.push({ player_id: me.id, hex_id: json.p_hex_id })
      return [200, true]
    },
    // Once per player; the drop stays open. A drop seeded from an event checks you in to that event too.
    claim_drop: (json, me) => {
      const drop = drops.find((d) => d.id === json.p_drop_id)
      if (!me) return [400, { message: 'Join before checking in' }]
      if (drop?.type === 'meetup') return [400, { message: "Meetups are just for showing up, there's nothing to check in to" }]
      if (!drop || drop.type !== 'checkin' || drop.status !== 'active' || (drop.expires_at && Date.parse(drop.expires_at) <= Date.now())) {
        return [400, { message: 'This drop is no longer available' }]
      }
      if (!proofOk(json, drop)) return [400, { message: json.p_code != null ? "That QR code doesn't match this drop" : 'Get closer to this drop' }]
      if (claims.some((c) => c.drop_id === drop.id && c.player_id === me.id)) return [400, { message: 'You already checked in here' }]
      const claim = { id: randomUUID(), drop_id: drop.id, player_id: me.id, points: drop.points, created_at: now() }
      claims.push(claim)
      const eventId = drop.source_id?.startsWith('discover:') && drop.source_id.slice('discover:'.length)
      if (eventId && discoverEvents.some((e) => e.id === eventId)) checkIn(eventId, me.id)
      return [200, claim]
    },
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', '*')
    res.setHeader('Access-Control-Expose-Headers', '*')
    if (req.method === 'OPTIONS') return res.end()
    let body = ''
    for await (const chunk of req) body += chunk
    const json = body ? JSON.parse(body) : {}
    const url = new URL(req.url, 'http://mock')
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const single = (req.headers.accept ?? '').includes('vnd.pgrst.object')
    const reply = (rows) => (single ? (rows.length === 1 ? send(200, rows[0]) : send(406, { message: 'expected one row' })) : send(200, rows))

    // Test-only introspection, e.g. to read check-ins or a drop's QR code.
    if (url.pathname === '/__state') {
      return send(200, { log, players, drops, claims, discovered, secrets, discoverEvents, discoverLocations, eventRsvps, eventCheckins, eventSecrets, organizers, requests, profiles })
    }
    if (url.pathname === '/auth/v1/signup') {
      const id = randomUUID()
      const user = { id, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: now() }
      return send(200, { access_token: jwt(id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'mock', user })
    }
    if (url.pathname.startsWith('/auth/v1/')) return send(200, {})
    // Stands in for web/api/search-events.ts in e2e (the test routes the app's request here): fixed results, so the
    // UI flow doesn't depend on the snapshot's dates. tests/api runs the real handler with Gemini faked.
    if (url.pathname === '/__search-events') {
      const query = String(json.query ?? '').toLowerCase()
      if (query.includes('busy')) return send(503, { error: 'The event finder is busy right now. Try again in a minute' })
      if (query.includes('zzz')) return send(200, { results: [], dropIds: [] })
      const at = (hours) => new Date(Date.now() + hours * 3600_000).toISOString()
      // Of the live drops the app sent, the picnic fits anything food-related.
      const sent = Array.isArray(json.drops) ? json.drops : []
      const dropIds = query.includes('food') ? sent.filter((d) => /picnic/i.test(d.title)).map((d) => d.id) : []
      return send(200, {
        dropIds,
        // "offline" in the query plays a Gemini outage: the server answered with its keyword search.
        mode: query.includes('offline') ? 'keyword' : 'ai',
        results: [
          // Pattee, not the HUB: the HUB already glows for its check-in drop, so the test couldn't see the search light it.
          { id: 'e2e-pattee', title: 'Late Night Pancakes', organization: 'Library Programming', theme: 'Social', starts_at: at(1), ends_at: at(3), location: 'Pattee 103',
            building: { num: '0003000', name: 'Pattee Library (Fred Lewis)', lat: 40.797799, lng: -77.866229 }, reason: 'Mock: free pancakes at Pattee.' },
          { id: 'e2e-linked', title: 'Lawn Picnic', organization: 'Penn State Picnic Club', theme: 'Social', starts_at: at(1), ends_at: at(3), location: 'Old Main lawn',
            building: { num: '0001000', name: 'Old Main', lat: 40.796443, lng: -77.862804 }, reason: 'Mock: a picnic with food.' },
          { id: 'e2e-online', title: 'Virtual Study Hall', organization: 'World Campus', theme: 'Learning', starts_at: at(2), ends_at: at(4), location: 'Online',
            building: null, reason: 'Mock: snacks not included, but good company.' },
        ],
      })
    }
    // Stands in for web/api/club-insights.ts in e2e: fixed suggestions, and interest counted from RSVPs only (the real
    // handler also counts profile matches; tests/api checks it).
    if (url.pathname === '/__club-insights') {
      const org = String(json.organization ?? '')
      const ids = discoverEvents.filter((e) => e.organization === org && Date.parse(e.ends_at) > Date.now()).map((e) => e.id)
      const byEvent = Object.fromEntries(ids.map((id) => [id, eventRsvps.filter((r) => r.event_id === id).length + 1]))
      const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString()
      return send(200, {
        interested: Object.values(byEvent).reduce((a, b) => a + b, 0),
        interestedByEvent: byEvent,
        mode: 'stats',
        suggestions: [
          { starts_at: days(3), building: { num: '0401000', name: 'Osmond Laboratory' }, reason: 'Mock: your Tuesday events drew the most people.' },
          { starts_at: days(4), building: null, reason: 'Mock: nothing else on campus then.' },
        ],
      })
    }
    // supabase-js falls back to HTTP for broadcasts when the socket is down; there is nobody to relay to here.
    if (url.pathname === '/realtime/v1/api/broadcast') return send(202, {})

    const path = url.pathname.replace('/rest/v1/', '')
    const me = players.find((p) => p.auth_id === subFrom(req))
    if (path.startsWith('rpc/')) {
      const fn = rpc[path.slice(4)]
      if (!fn) return send(404, { message: `mock: no rpc ${path}` })
      const [status, data] = fn(json, me, req)
      return send(status, data)
    }
    if (req.method === 'POST' && path === 'players') {
      // Everyone is an admin in the mock so admin screens are testable.
      const p = { id: randomUUID(), auth_id: subFrom(req), ...json, color: PALETTE[players.length % PALETTE.length], is_admin: true, created_at: now() }
      players.push(p)
      return reply([p])
    }
    if (req.method === 'POST' && path === 'drops') {
      if (json.type !== 'checkin') return send(400, { message: 'Mini-games and photo hunts were removed. Drop a check-in instead' })
      const d = { id: randomUUID(), status: 'active', points: 10, hint_photo_url: null, building_num: null, expires_at: null, subtitle: null, starts_at: null, source_id: null, created_at: now(), ...json }
      drops.push(d)
      secrets.push({ drop_id: d.id, claim_code: randomUUID().replaceAll('-', '') })
      return reply([d])
    }
    const service = req.headers.authorization === `Bearer ${SERVICE_ROLE_KEY}`
    if (path === 'discover_locations') {
      if (!service) return send(403, { message: 'permission denied for table discover_locations' })
      if (req.method === 'POST') {
        for (const row of [json].flat()) {
          const at = discoverLocations.findIndex((x) => x.location === row.location)
          if (at >= 0) discoverLocations[at] = row
          else discoverLocations.push(row)
        }
        return send(201, [])
      }
      // `location=in.(…)`: the caller only looks up locations it has, so returning every row is equivalent.
      return reply(discoverLocations)
    }
    // player_profiles mirrors its RLS: each player reads and writes only their own row; the server reads them all.
    if (path === 'player_profiles') {
      if (service) return reply(profiles)
      if (!me) return send(403, { message: 'permission denied for table player_profiles' })
      if (req.method === 'POST') {
        const row = { ...json, player_id: me.id, updated_at: now() }
        const at = profiles.findIndex((p) => p.player_id === me.id)
        if (at >= 0) profiles[at] = row
        else profiles.push(row)
        return reply([row])
      }
      return reply(profiles.filter((p) => p.player_id === me.id))
    }
    if (path === 'discover_events') {
      if (!me && !service) return send(403, { message: 'permission denied for table discover_events' })
      const rows = filterRows(discoverEvents, url.searchParams).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
      return reply(rows.slice(0, Number(url.searchParams.get('limit') ?? rows.length)))
    }
    // Own rows only, as RLS has it; the service role (and, for organizers, admins) read everything.
    const own = (rows) => (service ? rows : rows.filter((r) => r.player_id === me?.id))
    const tables = {
      players,
      drops,
      drop_secrets: secrets,
      discovered_areas: discovered.filter((d) => d.player_id === me?.id),
      event_rsvps: own(eventRsvps),
      event_checkins: own(eventCheckins),
      club_organizers: me?.is_admin || service ? organizers : own(organizers),
      organizer_requests: me?.is_admin || service ? requests : own(requests),
    }
    if (tables[path]) return reply(filterRows(tables[path], url.searchParams))
    send(404, { message: `mock: no route ${req.method} ${url.pathname}` })
  })

  // Tests reach the data directly (e.g. to add past check-ins, which no RPC allows).
  server.db = db
  return new Promise((resolve) => server.listen(port, () => resolve(server)))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMockSupabase()
  console.log(`mock supabase on http://localhost:${MOCK_PORT}`)
}
