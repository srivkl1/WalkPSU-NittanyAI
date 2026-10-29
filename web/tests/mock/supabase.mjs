// In-memory stand-in for the Supabase REST/auth/RPC endpoints the app uses, for UI tests without a real project.
// It mirrors the SQL rules closely enough to drive the screens (60 m claim radius, QR codes, Shake-Off timing and
// caps, Quick Draw rounds, Point to the Landmark rounds, photo hunts) but it is not the source of truth: tests/sql checks the real functions. No Realtime: the app's refresh() and
// polling fallbacks keep screens current, exactly as on flaky venue Wi-Fi.
//
//   node tests/mock/supabase.mjs            # serves on :54321
//   VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=mock npm run dev
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const MOCK_PORT = 54321
export const OLD_MAIN_LAWN = { lat: 40.7982, lng: -77.8599 }
/** The hidden photo hunt's real spot, ~250 m north of the lawn. Its search circle is centered 60 m east of it. */
export const HUNT_SPOT = { lat: OLD_MAIN_LAWN.lat + 250 / 111_195, lng: OLD_MAIN_LAWN.lng }
const HUNT_WINDOW_MS = 7 * 60_000
const RADIUS_M = 60
/** Stands in for the service_role key: only requests carrying it may call the service-only hunt functions. */
export const SERVICE_ROLE_KEY = 'mock-service-role'
/** 1x1 PNG, served as the hunt's reference photo so the card and /api/verify-photo have a real image to load. */
const HINT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
// A shorter countdown than production so tests run fast; the client must take timing from here, not hard-code it.
const SETTINGS = { game_seconds: 15, auto_start_players: 4, auto_start_delay_seconds: 4, admin_start_delay_seconds: 3, max_shakes_per_second: 8, submit_grace_seconds: 3 }
// Quick Draw, also shortened: 3 rounds of 5 s, each signal 1.5-2.5 s in. Real values come from minigame_settings().
const QUICK_DRAW = {
  ...SETTINGS, game_seconds: 15, rounds: 3, round_seconds: 5, min_signal_delay_ms: 1500, max_signal_delay_ms: 2500,
  min_reaction_ms: 100, max_reaction_ms: 1500, clock_tolerance_ms: 1000,
}
// Needle Rain, shortened so a headless round can finish. Real values come from needle_rain_settings().
const NEEDLE = { ...SETTINGS, game_seconds: 8, auto_start_players: 2, auto_start_delay_seconds: 2, admin_start_delay_seconds: 2, max_dodges_per_second: 4, submit_grace_seconds: 2 }
export const NEEDLE_SPOT = { lat: OLD_MAIN_LAWN.lat + 500 / 111_195, lng: OLD_MAIN_LAWN.lng }
// Point to the Landmark, shortened: 3 rounds of 12 s, 6 s of them to point.
const LANDMARK = {
  ...SETTINGS, game_seconds: 36, rounds: 3, round_seconds: 12, point_seconds: 6, steady_ms: 1000, steady_degrees: 6, lock_after_ms: 1500,
  min_landmark_m: 200, miss_degrees: 180,
}
/** A few rows of SQL campus_landmarks. */
const LANDMARKS = [
  { num: '0001000', name: 'Old Main', lat: 40.796443, lng: -77.862804 },
  { num: '0812000', name: 'Beaver Stadium', lat: 40.812537, lng: -77.855221 },
  { num: '0045000', name: 'Bryce Jordan Center', lat: 40.808639, lng: -77.855565 },
  { num: '0003000', name: 'Pattee Library', lat: 40.797799, lng: -77.866229 },
  { num: '0005000', name: 'the HUB', lat: 40.798261, lng: -77.861197 },
  { num: '0801000', name: 'Rec Hall', lat: 40.796017, lng: -77.869278 },
]
/** Bots' errors per round, in degrees: they point late and badly, so the e2e player's side wins. */
const BOT_ERRORS = { bot0: [50, 70, 60], bot1: [40, 45, 35], bot2: [80, 65, 75] }
const settingsOf = (kind) => ({ quick_draw: QUICK_DRAW, landmark: LANDMARK, needle_rain: NEEDLE })[kind] ?? SETTINGS
/** Bots' Quick Draw times per round: valid but slow, so the e2e player wins however fast the test machine is. */
const BOT_TIMES = { bot0: [1300, 1350, 1320], bot1: [1200, 1250, 1180], bot2: [1400, 1380, 1420] }
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4']
const BOT_SHAKES = 20

const R = 6371000
const rad = (d) => (d * Math.PI) / 180
/** SQL bearing_deg / angle_diff. */
const deg = (r) => (r * 180) / Math.PI
const bearing = (lat1, lng1, lat2, lng2) =>
  (deg(Math.atan2(Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2)), Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1)))) + 360) % 360
const angleDiff = (a, b) => 180 - Math.abs(180 - ((((a - b) % 360) + 360) % 360))
const distance = (a, b, c, d) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2))
const now = () => new Date().toISOString()

function seed() {
  const players = [{ id: 'rival', auth_id: 'rival', display_name: 'Rival <b>Ray</b>', color: PALETTE[0], is_admin: false, created_at: now() }]
  for (const [i, name] of ['Bot Ana', 'Bot Ben', 'Bot Cal'].entries()) {
    players.push({ id: `bot${i}`, auth_id: `bot${i}`, display_name: name, color: PALETTE[i + 1], is_admin: false, created_at: now() })
  }
  const drop = (id, title, type, lat, lng, points, building_num, extra = {}) => ({
    id, title, type, lat, lng, points, status: 'active', hint_photo_url: null, building_num, created_by: null, created_at: now(), expires_at: null,
    subtitle: null, starts_at: null, source_id: null, twist: null, search_radius_m: null, first_found_at: null,
    game: type === 'minigame' ? 'shake_off' : null, ...extra,
  })
  const drops = [
    // Shaped like a drop seeded from a Penn State Discover event, so the card shows its organization and time.
    drop('center-drop', 'Old Main lawn', 'checkin', OLD_MAIN_LAWN.lat, OLD_MAIN_LAWN.lng, 15, null, {
      subtitle: 'Penn State Outing Club',
      starts_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 90 * 60_000).toISOString(),
      source_id: 'discover:mock',
    }),
    // ~30 m east of the lawn drop, at the HUB (so the map highlights building 0005000).
    drop('game-drop', 'HUB Shake-Off', 'minigame', OLD_MAIN_LAWN.lat, OLD_MAIN_LAWN.lng + 30 / (111_195 * Math.cos(rad(OLD_MAIN_LAWN.lat))), 30, '0005000'),
    // ~30 m south of the lawn drop, in the open.
    drop('draw-drop', 'Lawn Quick Draw', 'minigame', OLD_MAIN_LAWN.lat - 30 / 111_195, OLD_MAIN_LAWN.lng, 25, null, { game: 'quick_draw' }),
    // Open ground, ~500 m north, so it never highlights a building. One bot is already in, so joining starts it.
    drop('needle-drop', 'Open Needle Rain', 'minigame', NEEDLE_SPOT.lat, NEEDLE_SPOT.lng, 40, null, { game: 'needle_rain' }),
    // ~30 m west of the lawn drop.
    drop('aim-drop', 'Lawn Landmarks', 'minigame', OLD_MAIN_LAWN.lat, OLD_MAIN_LAWN.lng - 30 / (111_195 * Math.cos(rad(OLD_MAIN_LAWN.lat))), 35, null, { game: 'landmark' }),
    // Hidden photo hunt: the public row has only the search circle's center and no building.
    drop('hunt-drop', 'Mystery spot', 'photo_hunt', HUNT_SPOT.lat, HUNT_SPOT.lng + 60 / (111_195 * Math.cos(rad(HUNT_SPOT.lat))), 20, null, {
      twist: 'with a thumbs up',
      search_radius_m: 125,
      hint_photo_url: `http://localhost:${MOCK_PORT}/__hint.png`,
    }),
    // A check-in seeded from a Discover event (source_id), so AI search results can link to it. Open ground ~400 m
    // southwest, so it highlights no building.
    drop('event-drop', 'Lawn Picnic', 'checkin', OLD_MAIN_LAWN.lat - 280 / 111_195, OLD_MAIN_LAWN.lng - 280 / (111_195 * Math.cos(rad(OLD_MAIN_LAWN.lat))), 15, null, {
      subtitle: 'Penn State Picnic Club',
      starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      source_id: 'discover:e2e-linked',
    }),
  ]
  const hunt = { hunt_lat: HUNT_SPOT.lat, hunt_lng: HUNT_SPOT.lng, hunt_building_num: null }
  return {
    players,
    drops,
    claims: [],
    discovered: [],
    searchQuota: new Map(),
    discoverEvents: [],
    discoverLocations: [],
    eventRsvps: [],
    profiles: [],
    secrets: drops.map((d) => ({ drop_id: d.id, claim_code: `${d.id}-code`, ...(d.type === 'photo_hunt' ? hunt : {}) })),
    games: (() => {
      const games = new Map(['game-drop', 'draw-drop', 'aim-drop', 'needle-drop'].map((id) => [id, newGame(id)]))
      const ghost = games.get('needle-drop')
      ghost.ghost_dodges = 12
      ghost.ghost_player_id = 'bot0'
      ghost.ghost_name = 'Bot Ana'
      return games
    })(),
    // Three bots wait in the Shake-Off, Quick Draw, and Landmark lobbies. Needle Rain has one, so joining makes 2.
    gamePlayers: ['game-drop', 'draw-drop', 'aim-drop'].flatMap((dropId) =>
      ['bot0', 'bot1', 'bot2'].map((id, i) => ({ drop_id: dropId, player_id: id, joined_at: new Date(Date.now() - 60_000 + i).toISOString(), shakes: 0, dodges: 0, eliminated: false })),
    ).concat([{ drop_id: 'needle-drop', player_id: 'bot0', joined_at: new Date(Date.now() - 60_000).toISOString(), shakes: 0, dodges: 0, eliminated: false }]),
    results: [],
    log: [],
  }
}

/** A games row. `delays` stands in for the SQL seed: each Quick Draw round's hidden signal delay. */
function newGame(dropId) {
  const delays = [0, 1, 2].map(() => QUICK_DRAW.min_signal_delay_ms + Math.floor(Math.random() * (QUICK_DRAW.max_signal_delay_ms - QUICK_DRAW.min_signal_delay_ms + 1)))
  const shuffled = [...LANDMARKS].sort(() => Math.random() - 0.5)
  return {
    drop_id: dropId, created_at: now(), started_at: null, finished_at: null, winner_side: null, winner_id: null, delays, shuffled,
    round_seed: null, ghost_seed: randomUUID().replaceAll('-', ''), ghost_dodges: null, ghost_player_id: null, ghost_name: null,
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

/** Supports the PostgREST filters the app sends: `col=eq.value`; ordering and `or=` are ignored. */
const filterRows = (rows, params) =>
  rows.filter((row) => [...params].every(([k, v]) => !v.startsWith('eq.') || String(row[k]) === v.slice(3)))

export function startMockSupabase({ port = MOCK_PORT } = {}) {
  const db = seed()
  const { players, drops, claims, discovered, searchQuota, discoverEvents, discoverLocations, eventRsvps, profiles, secrets, games, gamePlayers, results, log } = db
  const kindOf = (dropId) => drops.find((d) => d.id === dropId)?.game ?? 'shake_off'
  const roundsOf = (dropId) => {
    const g = games.get(dropId)
    if (!g?.started_at) return []
    const start = Date.parse(g.started_at)
    if (kindOf(dropId) === 'landmark') {
      const drop = drops.find((d) => d.id === dropId)
      return g.shuffled
        .filter((l) => distance(drop.lat, drop.lng, l.lat, l.lng) >= LANDMARK.min_landmark_m)
        .slice(0, LANDMARK.rounds)
        .map((landmark, i) => ({
          round: i + 1,
          starts_at: new Date(start + i * LANDMARK.round_seconds * 1000).toISOString(),
          landmark,
          bearing: bearing(drop.lat, drop.lng, landmark.lat, landmark.lng),
        }))
    }
    if (kindOf(dropId) !== 'quick_draw') return []
    return g.delays.map((delay, i) => ({
      round: i + 1,
      starts_at: new Date(start + i * QUICK_DRAW.round_seconds * 1000).toISOString(),
      signal_at: new Date(start + i * QUICK_DRAW.round_seconds * 1000 + delay).toISOString(),
    }))
  }

  const sidesOf = (dropId) => {
    if (!games.get(dropId)?.started_at) return new Map()
    const roster = gamePlayers.filter((gp) => gp.drop_id === dropId).sort((a, b) => a.joined_at.localeCompare(b.joined_at))
    return new Map(roster.map((gp, i) => [gp.player_id, i % 2 === 0 ? 'blue' : 'white']))
  }
  /** Landmark bots lock their (poor) headings when each round's pointing time ends. */
  const botsPoint = (dropId) => {
    if (kindOf(dropId) !== 'landmark') return
    for (const r of roundsOf(dropId)) {
      if (Date.now() < Date.parse(r.starts_at) + LANDMARK.point_seconds * 1000) continue
      for (const gp of gamePlayers.filter((x) => x.drop_id === dropId && x.player_id.startsWith('bot'))) {
        if (results.some((x) => x.drop_id === dropId && x.player_id === gp.player_id && x.round === r.round)) continue
        const error = BOT_ERRORS[gp.player_id][r.round - 1]
        results.push({ drop_id: dropId, player_id: gp.player_id, round: r.round, value: error, false_start: false, heading: (r.bearing + error) % 360, created_at: now() })
      }
    }
  }
  const gameState = (dropId) => {
    const sides = sidesOf(dropId)
    botsPoint(dropId)
    // The delays and shuffle stand in for the SQL seed, which get_game_state() never returns.
    const { delays: _seed, shuffled: _order, round_seed, ...game } = games.get(dropId) ?? {}
    return {
      server_now: now(),
      kind: kindOf(dropId),
      settings: settingsOf(kindOf(dropId)),
      game: game.drop_id ? { ...game, round_seed: game.started_at ? round_seed : null } : null,
      rounds: roundsOf(dropId),
      results: results.filter((r) => r.drop_id === dropId).map(({ player_id, round, value, false_start, heading }) => ({ player_id, round, value, false_start, heading: heading ?? null })),
      players: gamePlayers
        .filter((gp) => gp.drop_id === dropId)
        .map((gp) => {
          const p = players.find((x) => x.id === gp.player_id)
          return { player_id: p.id, display_name: p.display_name, color: p.color, side: sides.get(p.id) ?? null, shakes: gp.shakes, dodges: gp.dodges ?? 0, eliminated: gp.eliminated ?? false, joined_at: gp.joined_at }
        }),
    }
  }
  const scores = () =>
    players
      .map((p) => ({
        player_id: p.id,
        display_name: p.display_name,
        color: p.color,
        points: claims.filter((c) => c.player_id === p.id).reduce((sum, c) => sum + c.points, 0),
        claims: claims.filter((c) => c.player_id === p.id).length,
      }))
      .sort((a, b) => b.points - a.points || a.display_name.localeCompare(b.display_name))
  const proofOk = (json, drop) =>
    json.p_code != null
      ? json.p_code === secrets.find((s) => s.drop_id === drop.id)?.claim_code
      : json.p_lat != null && distance(json.p_lat, json.p_lng, drop.lat, drop.lng) <= RADIUS_M

  // photo_hunt_check / claim_photo_hunt, in the SQL's order of checks. Return [status, drop or claim or error].
  const huntCheck = (json) => {
    const drop = drops.find((d) => d.id === json.p_drop_id && d.type === 'photo_hunt')
    if (!drop) return [400, { message: 'Photo hunt not found' }]
    if (drop.status !== 'active' || (drop.expires_at && Date.parse(drop.expires_at) <= Date.now())) return [400, { message: 'This hunt is over' }]
    if (claims.some((c) => c.drop_id === drop.id && c.player_id === json.p_player_id)) return [400, { message: 'You already found this one' }]
    if (json.p_lat == null || json.p_lng == null) return [400, { message: 'Turn on location to submit a photo' }]
    const secret = secrets.find((x) => x.drop_id === drop.id)
    if (distance(json.p_lat, json.p_lng, secret.hunt_lat ?? drop.lat, secret.hunt_lng ?? drop.lng) > RADIUS_M) {
      return [400, { message: "This isn't the spot. Keep looking!" }]
    }
    return [200, drop]
  }
  const huntClaim = (json) => {
    const [status, drop] = huntCheck(json)
    if (status !== 200) return [status, drop]
    const found = claims.filter((c) => c.drop_id === drop.id).length
    const claim = { id: randomUUID(), drop_id: drop.id, player_id: json.p_player_id, points: Math.max(1, Math.floor(drop.points / 2 ** found)), created_at: now() }
    claims.push(claim)
    if (found === 0) {
      const secret = secrets.find((x) => x.drop_id === drop.id)
      Object.assign(drop, { lat: secret.hunt_lat, lng: secret.hunt_lng, building_num: secret.hunt_building_num, first_found_at: now() })
      drop.expires_at = new Date(Math.min(Date.now() + HUNT_WINDOW_MS, drop.expires_at ? Date.parse(drop.expires_at) : Infinity)).toISOString()
    }
    return [200, claim]
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
        const next = { ...e, cancelled: false, synced_at: now() }
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
        expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), source_id: null, twist: null, search_radius_m: null, first_found_at: null,
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
    photo_hunt_check: serviceOnly(huntCheck),
    claim_photo_hunt: serviceOnly(huntClaim),
    claim_drop: (json, me) => {
      const drop = drops.find((d) => d.id === json.p_drop_id)
      if (!me) return [400, { message: 'Join the game before claiming drops' }]
      if (drop?.type === 'minigame') {
        const label = drop.game === 'needle_rain' ? 'Needle Rain' : 'Shake-Off'
        return [400, { message: `This drop is a ${label}. Join its lobby to win it` }]
      }
      if (drop?.type === 'photo_hunt') return [400, { message: 'Photo hunts are claimed by taking the photo' }]
      if (drop?.type === 'meetup') return [400, { message: 'Meetups are for showing up, not for points' }]
      if (!drop || drop.status !== 'active') return [400, { message: 'This drop is no longer available' }]
      if (!proofOk(json, drop)) return [400, { message: json.p_code != null ? "That QR code doesn't match this drop" : 'Get closer to claim this drop' }]
      drop.status = 'claimed'
      const claim = { id: randomUUID(), drop_id: drop.id, player_id: me.id, points: drop.points, created_at: now() }
      claims.push(claim)
      return [200, claim]
    },
    create_photo_hunt: (json, me) => {
      if (!me?.is_admin) return [400, { message: 'Only admins can create photo hunts' }]
      const d = {
        id: randomUUID(), title: json.p_title, type: 'photo_hunt', lat: json.p_lat + 50 / 111_195, lng: json.p_lng, points: json.p_points ?? 10,
        status: 'active', hint_photo_url: json.p_hint_photo_url, building_num: null, created_by: me.id, created_at: now(),
        expires_at: json.p_expires_at ?? null, twist: json.p_twist.trim(), search_radius_m: 125, first_found_at: null,
      }
      drops.push(d)
      secrets.push({ drop_id: d.id, claim_code: randomUUID().replaceAll('-', ''), hunt_lat: json.p_lat, hunt_lng: json.p_lng, hunt_building_num: json.p_building_num ?? null })
      return [200, d]
    },
    get_game_state: (json) => [200, gameState(json.p_drop_id)],
    join_game: (json, me) => {
      if (!games.has(json.p_drop_id)) games.set(json.p_drop_id, newGame(json.p_drop_id))
      const g = games.get(json.p_drop_id)
      if (gamePlayers.some((gp) => gp.drop_id === json.p_drop_id && gp.player_id === me.id)) return [200, null]
      if (g.started_at && Date.parse(g.started_at) <= Date.now()) return [400, { message: 'This Shake-Off already started' }]
      if (!proofOk(json, drops.find((d) => d.id === json.p_drop_id))) return [400, { message: 'Get closer to this drop' }]
      gamePlayers.push({ drop_id: json.p_drop_id, player_id: me.id, joined_at: now(), shakes: 0, dodges: 0, eliminated: false })
      const settings = settingsOf(kindOf(json.p_drop_id))
      if (!g.started_at && gamePlayers.filter((gp) => gp.drop_id === json.p_drop_id).length >= settings.auto_start_players) {
        g.started_at = new Date(Date.now() + settings.auto_start_delay_seconds * 1000).toISOString()
        if (kindOf(json.p_drop_id) === 'needle_rain') g.round_seed = g.round_seed ?? randomUUID().replaceAll('-', '')
      }
      return [200, null]
    },
    start_game: (json, me) => {
      const g = games.get(json.p_drop_id)
      if (!me?.is_admin) return [400, { message: 'Only admins can start a Shake-Off' }]
      const settings = settingsOf(kindOf(json.p_drop_id))
      const start = Date.now() + settings.admin_start_delay_seconds * 1000
      if (!g.started_at || Date.parse(g.started_at) > start) g.started_at = new Date(start).toISOString()
      if (kindOf(json.p_drop_id) === 'needle_rain') g.round_seed = g.round_seed ?? randomUUID().replaceAll('-', '')
      return [200, null]
    },
    submit_reaction: (json, me) => {
      const g = games.get(json.p_drop_id)
      if (kindOf(json.p_drop_id) !== 'quick_draw' || !g?.started_at || Date.now() < Date.parse(g.started_at)) return [400, { message: "This Quick Draw hasn't started" }]
      if (g.finished_at) return [400, { message: 'This Quick Draw is over' }]
      if (!gamePlayers.some((gp) => gp.drop_id === json.p_drop_id && gp.player_id === me?.id)) return [400, { message: "You're not in this Quick Draw" }]
      const round = roundsOf(json.p_drop_id).find((r) => r.round === json.p_round)
      if (!round) return [400, { message: `There's no round ${json.p_round}` }]
      const signal = Date.parse(round.signal_at)
      if (Date.now() < Date.parse(round.starts_at)) return [400, { message: `Round ${json.p_round} hasn't started` }]
      if (Date.now() > signal + QUICK_DRAW.max_reaction_ms + QUICK_DRAW.submit_grace_seconds * 1000) return [400, { message: `Round ${json.p_round} is over` }]
      const ms = json.p_reaction_ms ?? null
      if (ms !== null && (ms < 0 || ms > QUICK_DRAW.max_reaction_ms)) return [400, { message: `A reaction time of ${ms} ms isn't possible` }]
      if (ms !== null && Date.now() < signal + ms - QUICK_DRAW.clock_tolerance_ms) return [400, { message: `No signal was shown yet in round ${json.p_round}` }]
      const falseStart = ms === null || ms < QUICK_DRAW.min_reaction_ms
      let row = results.find((r) => r.drop_id === json.p_drop_id && r.player_id === me.id && r.round === json.p_round)
      if (!row) {
        row = { drop_id: json.p_drop_id, player_id: me.id, round: json.p_round, value: falseStart ? null : ms, false_start: falseStart, created_at: now() }
        results.push(row)
        log.push(`reaction round ${row.round}: ${row.false_start ? 'false start' : `${row.value} ms`}`)
      }
      return [200, row]
    },
    submit_heading: (json, me) => {
      const g = games.get(json.p_drop_id)
      if (kindOf(json.p_drop_id) !== 'landmark' || !g?.started_at || Date.now() < Date.parse(g.started_at)) return [400, { message: "This Landmark game hasn't started" }]
      if (g.finished_at) return [400, { message: 'This Landmark game is over' }]
      if (!gamePlayers.some((gp) => gp.drop_id === json.p_drop_id && gp.player_id === me?.id)) return [400, { message: "You're not in this Landmark game" }]
      const round = roundsOf(json.p_drop_id).find((r) => r.round === json.p_round)
      if (!round) return [400, { message: `There's no round ${json.p_round}` }]
      if (!(json.p_heading >= 0 && json.p_heading < 360)) return [400, { message: 'A heading must be from 0 up to 360 degrees' }]
      const start = Date.parse(round.starts_at)
      if (Date.now() < start) return [400, { message: `Round ${json.p_round} hasn't started` }]
      if (Date.now() > start + (LANDMARK.point_seconds + LANDMARK.submit_grace_seconds) * 1000) return [400, { message: `Round ${json.p_round} is over` }]
      let row = results.find((r) => r.drop_id === json.p_drop_id && r.player_id === me.id && r.round === json.p_round)
      if (!row) {
        row = { drop_id: json.p_drop_id, player_id: me.id, round: json.p_round, value: angleDiff(json.p_heading, round.bearing), false_start: false, heading: json.p_heading, created_at: now() }
        results.push(row)
        log.push(`heading round ${row.round}: ${row.heading.toFixed(1)} (${row.value.toFixed(1)} off)`)
      }
      return [200, row]
    },
    submit_shakes: (json, me) => {
      const started = Date.parse(games.get(json.p_drop_id)?.started_at ?? '')
      if (!started || Date.now() < started) return [400, { message: "This Shake-Off hasn't started" }]
      if (Date.now() > started + (SETTINGS.game_seconds + SETTINGS.submit_grace_seconds) * 1000) return [400, { message: 'This Shake-Off is over' }]
      const gp = gamePlayers.find((x) => x.drop_id === json.p_drop_id && x.player_id === me.id)
      const elapsed = Math.min((Date.now() - started) / 1000, SETTINGS.game_seconds)
      gp.shakes = Math.max(gp.shakes, Math.min(Math.max(json.p_count, 0), Math.floor(elapsed * SETTINGS.max_shakes_per_second)))
      log.push(`submit ${json.p_count} -> stored ${gp.shakes} at ${elapsed.toFixed(1)}s`)
      return [200, gp.shakes]
    },
    submit_dodges: (json, me) => {
      if (kindOf(json.p_drop_id) !== 'needle_rain') return [400, { message: "This drop isn't a Needle Rain" }]
      const g = games.get(json.p_drop_id)
      const started = Date.parse(g?.started_at ?? '')
      if (!started || Date.now() < started) return [400, { message: "This Needle Rain hasn't started" }]
      if (Date.now() > started + (NEEDLE.game_seconds + NEEDLE.submit_grace_seconds) * 1000) return [400, { message: 'This Needle Rain is over' }]
      const gp = gamePlayers.find((x) => x.drop_id === json.p_drop_id && x.player_id === me?.id)
      if (!gp) return [400, { message: "You're not in this Needle Rain" }]
      if (gp.eliminated) return [200, gp.dodges]
      const elapsed = Math.min((Date.now() - started) / 1000, NEEDLE.game_seconds)
      gp.dodges = Math.max(gp.dodges, Math.min(Math.max(json.p_count, 0), Math.floor(elapsed * NEEDLE.max_dodges_per_second)))
      if (json.p_eliminated) gp.eliminated = true
      return [200, gp.dodges]
    },
    submit_ghost: (json, me) => {
      if (kindOf(json.p_drop_id) !== 'needle_rain') return [400, { message: "This drop isn't a Needle Rain" }]
      const g = games.get(json.p_drop_id)
      if (!gamePlayers.some((gp) => gp.drop_id === json.p_drop_id && gp.player_id === me?.id)) return [400, { message: "You're not in this Needle Rain" }]
      if (g.finished_at || (g.started_at && Date.parse(g.started_at) <= Date.now())) return [400, { message: 'The round already started' }]
      const cap = NEEDLE.game_seconds * NEEDLE.max_dodges_per_second
      const count = Math.min(Math.max(json.p_count, 0), cap)
      if ((g.ghost_dodges ?? -1) < count) {
        g.ghost_dodges = count
        g.ghost_player_id = me.id
        g.ghost_name = me.display_name
      }
      return [200, count]
    },
    finish_game: (json) => {
      const g = games.get(json.p_drop_id)
      const kind = kindOf(json.p_drop_id)
      const settings = settingsOf(kind)
      if (!g.finished_at) {
        if (Date.now() < Date.parse(g.started_at) + (settings.game_seconds + settings.submit_grace_seconds) * 1000) return [400, { message: "This Shake-Off isn't over yet" }]
        const roster = gamePlayers.filter((gp) => gp.drop_id === json.p_drop_id)
        const drop = drops.find((d) => d.id === json.p_drop_id)
        if (kind === 'needle_rain') {
          for (const gp of roster) if (gp.player_id.startsWith('bot') && gp.dodges === 0 && !gp.eliminated) gp.dodges = 3
          const alive = roster.filter((gp) => !gp.eliminated)
          const pool = (alive.length ? alive : roster).slice().sort((a, b) => b.dodges - a.dodges || a.joined_at.localeCompare(b.joined_at))
          g.winner_id = pool[0].player_id
          g.finished_at = now()
          drop.status = 'claimed'
          claims.push({ id: randomUUID(), drop_id: json.p_drop_id, player_id: g.winner_id, points: drop.points, created_at: g.finished_at })
          return [200, gameState(json.p_drop_id)]
        }
        for (const gp of roster) if (gp.player_id.startsWith('bot')) gp.shakes = BOT_SHAKES
        if (kind === 'quick_draw') {
          for (const gp of roster.filter((x) => x.player_id.startsWith('bot'))) {
            BOT_TIMES[gp.player_id].forEach((value, i) => results.push({ drop_id: json.p_drop_id, player_id: gp.player_id, round: i + 1, value, false_start: false, created_at: now() }))
          }
        }
        botsPoint(json.p_drop_id)
        // As SQL side_scores(): shakes per player, average error (a missed round = miss_degrees), or best valid time.
        const score = (gp) => {
          if (kind === 'shake_off') return gp.shakes
          if (kind === 'landmark') {
            const errors = [1, 2, 3].map((round) => results.find((r) => r.drop_id === json.p_drop_id && r.player_id === gp.player_id && r.round === round)?.value ?? LANDMARK.miss_degrees)
            return errors.reduce((a, b) => a + b, 0) / errors.length
          }
          const times = results.filter((r) => r.drop_id === json.p_drop_id && r.player_id === gp.player_id && r.value !== null).map((r) => r.value)
          return times.length ? Math.min(...times) : QUICK_DRAW.max_reaction_ms
        }
        const sides = sidesOf(json.p_drop_id)
        const avg = (side) => {
          const xs = roster.filter((gp) => sides.get(gp.player_id) === side).map(score)
          return xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
        }
        const blueWins = kind === 'shake_off' ? avg('blue') >= avg('white') : avg('blue') <= avg('white')
        g.winner_side = blueWins ? 'blue' : 'white'
        g.finished_at = now()
        drops.find((d) => d.id === json.p_drop_id).status = 'claimed'
        const points = drops.find((d) => d.id === json.p_drop_id).points
        for (const gp of roster) if (sides.get(gp.player_id) === g.winner_side) claims.push({ id: randomUUID(), drop_id: json.p_drop_id, player_id: gp.player_id, points, created_at: g.finished_at })
        log.push(`finish: blue ${avg('blue')} white ${avg('white')} -> ${g.winner_side}`)
      }
      return [200, gameState(json.p_drop_id)]
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

    // Test-only introspection, e.g. to read claims or a drop's QR code.
    if (url.pathname === '/__state') return send(200, { log, players, drops, claims, discovered, secrets, gamePlayers, results, games: [...games.values()], discoverEvents, discoverLocations, eventRsvps, profiles })
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
          // Pattee, not the HUB: the HUB already glows for the Shake-Off drop, so the test couldn't see the search light it.
          { id: 'e2e-pattee', title: 'Late Night Pancakes', organization: 'Library Programming', theme: 'Social', starts_at: at(1), ends_at: at(3), location: 'Pattee 103',
            building: { num: '0003000', name: 'Pattee Library (Fred Lewis)', lat: 40.797799, lng: -77.866229 }, reason: 'Mock: free pancakes at Pattee.' },
          { id: 'e2e-linked', title: 'Lawn Picnic', organization: 'Penn State Picnic Club', theme: 'Social', starts_at: at(1), ends_at: at(3), location: 'Old Main lawn',
            building: { num: '0001000', name: 'Old Main', lat: 40.796443, lng: -77.862804 }, reason: 'Mock: a picnic with food.' },
          { id: 'e2e-online', title: 'Virtual Study Hall', organization: 'World Campus', theme: 'Learning', starts_at: at(2), ends_at: at(4), location: 'Online',
            building: null, reason: 'Mock: snacks not included, but good company.' },
        ],
      })
    }
    if (url.pathname === '/__hint.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      return res.end(HINT_PNG)
    }
    // Stands in for web/api/verify-photo.ts in e2e (the test routes the app's request here), with Gemini replaced by
    // "any photo matches". tests/api runs the real verify-photo.ts against this mock's RPCs instead.
    if (url.pathname === '/__verify-photo') {
      const me = players.find((p) => p.auth_id === subFrom(req))
      if (!me) return send(403, { error: 'Join the game before claiming drops' })
      const args = { p_drop_id: json.dropId, p_player_id: me.id, p_lat: json.lat, p_lng: json.lng }
      const [status, checked] = huntCheck(args)
      if (status !== 200) return send(status, { error: checked.message })
      if (!json.image) return send(200, { match: false, reason: 'Mock referee: no photo' })
      const [, claim] = huntClaim(args)
      return send(200, { match: true, points: claim.points, reason: 'Mock referee: same spot, twist done.' })
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
      const d = { id: randomUUID(), status: 'active', points: 10, game: json.type === 'minigame' ? 'shake_off' : null, hint_photo_url: null, building_num: null, expires_at: null, subtitle: null, starts_at: null, source_id: null, created_at: now(), twist: null, search_radius_m: null, first_found_at: null, ...json }
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
    // player_profiles mirrors its RLS: each player reads and writes only their own row.
    if (path === 'player_profiles') {
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
      const after = url.searchParams.get('ends_at')?.replace(/^gt\./, '')
      const rows = discoverEvents
        .filter((e) => !e.cancelled && (!after || Date.parse(e.ends_at) > Date.parse(after)))
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
      return reply(rows.slice(0, Number(url.searchParams.get('limit') ?? rows.length)))
    }
    // discovered_areas mirrors its RLS: each player reads only their own rows.
    const tables = { players, drops, drop_secrets: secrets, player_scores: scores(), discovered_areas: discovered.filter((d) => d.player_id === me?.id) }
    if (tables[path]) return reply(filterRows(tables[path], url.searchParams))
    send(404, { message: `mock: no route ${req.method} ${url.pathname}` })
  })

  return new Promise((resolve) => server.listen(port, () => resolve(server)))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMockSupabase()
  console.log(`mock supabase on http://localhost:${MOCK_PORT}`)
}
