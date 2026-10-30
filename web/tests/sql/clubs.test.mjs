// Clubs: organizer requests and approval, event check-ins (QR, GPS, seeded drops), and club_stats (counts only).
import { LAT, LNG, M_PER_DEG_LAT, actor, check, createDb, finish, migrate, serviceRole, superuser } from './harness.mjs'

const db = await createDb()
await migrate(db)
const as = actor(db)
const su = superuser(db)
const server = serviceRole(db)
const admin = (q, p) => as('admin', { app_role: 'admin' }, q, p)

for (const n of ['org', 'p1', 'p2', 'p3']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
const idOf = async (sub) => (await su(`select id from players where auth_id = $1`, [sub]))[0].id
const building = { num: '0001000', name: 'Old Main', lat: LAT, lng: LNG }
const event = (id, org, startH, endH, { at = building, cancelled = false } = {}) =>
  su(
    `insert into discover_events (id, title, organization, starts_at, ends_at, building, cancelled)
     values ($1, $1, $2, now() + make_interval(mins => $3), now() + make_interval(mins => $4), $5, $6)`,
    [id, org, Math.round(startH * 60), Math.round(endH * 60), at && JSON.stringify(at), cancelled],
  )
await event('past1', 'Chess Club', -24 * 14, -24 * 14 + 2)
await event('past2', 'Chess Club', -24 * 7, -24 * 7 + 2)
await event('now', 'Chess Club', -0.5, 1.5)
await event('soon', 'Chess Club', 0.25, 2)
await event('later', 'Chess Club', 48, 50)
await event('online', 'Chess Club', -0.5, 1.5, { at: null })
await event('off', 'Chess Club', -0.5, 1.5, { cancelled: true })
await event('rival', 'Go Club', -0.5, 1.5)
let r

// --- Asking to run a club
r = await as('stranger', {}, `select * from request_organizer('Chess Club')`)
check('joining comes first', /Join before/.test(r.error ?? ''), r)
r = await as('org', {}, `select * from request_organizer('No Such Club')`)
check('only a club with Discover events', /not found/.test(r.error ?? ''), r)
r = await as('org', {}, `select * from request_organizer('Chess Club', '  I''m the president  ')`)
const request = r.rows?.[0]
check('a request waits for an admin, note trimmed', request?.status === 'pending' && request.note === "I'm the president", r)
r = await as('org', {}, `select * from request_organizer('Chess Club')`)
check('asking again returns the same request', r.rows?.[0]?.id === request?.id, r)
check('players can’t write requests directly', !!(await as('p1', {}, `insert into organizer_requests (organization, player_id) select 'Go Club', id from players limit 1`)).error)
check('a player sees only their own requests', (await as('p1', {}, `select * from organizer_requests`)).rows?.length === 0)
check('admins see every request', (await admin(`select * from organizer_requests`)).rows?.length === 1)
r = await as('p1', {}, `select * from decide_organizer_request($1, true)`, [request.id])
check('only admins approve', /Only admins/.test(r.error ?? ''), r)
r = await as('org', {}, `select club_stats('Chess Club')`)
check('no dashboard before approval', /Only this club/.test(r.error ?? ''), r)
r = await admin(`select * from decide_organizer_request($1, true)`, [request.id])
check('an admin approves', r.rows?.[0]?.status === 'approved' && !!r.rows[0].decided_at, r)
r = await admin(`select * from decide_organizer_request($1, false)`, [request.id])
check('a request is answered once', /already answered/.test(r.error ?? ''), r)
r = await as('org', {}, `select organization from club_organizers`)
check('the player now runs the club', JSON.stringify(r.rows) === '[{"organization":"Chess Club"}]', r)
check('players can’t make themselves organizers', !!(await as('p1', {}, `insert into club_organizers (organization, player_id) select 'Go Club', id from players limit 1`)).error)
check('and don’t see who runs a club', (await as('p1', {}, `select * from club_organizers`)).rows?.length === 0)
r = await as('org', {}, `select * from request_organizer('Chess Club')`)
check('an organizer can’t ask again', /already run/.test(r.error ?? ''), r)
const declined = (await as('p1', {}, `select * from request_organizer('Go Club')`)).rows[0]
r = await admin(`select * from decide_organizer_request($1, false)`, [declined.id])
check('a declined request makes no organizer', r.rows?.[0]?.status === 'declined' && (await su(`select count(*)::int as n from club_organizers where organization = 'Go Club'`))[0].n === 0, r)
for (let i = 0; i < 5; i++) await event(`club${i}`, `Club ${i}`, 1, 2)
for (let i = 0; i < 5; i++) await as('p2', {}, `select * from request_organizer($1)`, [`Club ${i}`])
r = await as('p2', {}, `select * from request_organizer('Go Club')`)
check('at most 5 requests waiting', /5 requests/.test(r.error ?? ''), r)

// --- Door QR codes
r = await as('p1', {}, `select event_checkin_code('now') as c`)
check('only organizers get an event’s QR code', /Only this club/.test(r.error ?? ''), r)
r = await as('org', {}, `select event_checkin_code('rival') as c`)
check('and only for their own club', /Only this club/.test(r.error ?? ''), r)
const code = (await as('org', {}, `select event_checkin_code('now') as c`)).rows?.[0]?.c
check('an organizer gets a 32-character code', code?.length === 32, code)
check('the same one every time', (await as('org', {}, `select event_checkin_code('now') as c`)).rows[0].c === code)
check('admins get it too', (await admin(`select event_checkin_code('now') as c`)).rows?.[0]?.c === code)
check('players can’t read codes directly', !!(await as('p1', {}, `select * from event_secrets`)).error)

// --- Checking in
const checkIn = (sub, id, { lat = null, lng = null, code = null } = {}) => as(sub, {}, `select check_in_event($1, $2, $3, $4) as new`, [id, lat, lng, code])
r = await checkIn('stranger', 'now', { lat: LAT, lng: LNG })
check('joining comes first', /Join before/.test(r.error ?? ''), r)
check('unknown event', /not found/.test((await checkIn('p1', 'nope', { lat: LAT, lng: LNG })).error ?? ''))
check('cancelled event', /cancelled/.test((await checkIn('p1', 'off', { lat: LAT, lng: LNG })).error ?? ''))
check('too early', /opens 30 minutes before/.test((await checkIn('p1', 'later', { lat: LAT, lng: LNG })).error ?? ''))
check('15 minutes early is fine', (await checkIn('p3', 'soon', { lat: LAT, lng: LNG })).rows?.[0]?.new === true)
check('over', /over/.test((await checkIn('p1', 'past2', { lat: LAT, lng: LNG })).error ?? ''))
check('wrong QR code', /doesn't match/.test((await checkIn('p1', 'now', { code: 'wrong' })).error ?? ''))
check('too far by GPS', /Get closer/.test((await checkIn('p1', 'now', { lat: LAT + 61 / M_PER_DEG_LAT, lng: LNG })).error ?? ''))
check('no location', /Location unavailable/.test((await checkIn('p1', 'now')).error ?? ''))
check('an event with no building needs its QR code', /Scan the event's QR/.test((await checkIn('p1', 'online', { lat: LAT, lng: LNG })).error ?? ''))
r = await checkIn('p1', 'now', { lat: LAT + 59 / M_PER_DEG_LAT, lng: LNG })
check('GPS inside the claim radius of the building checks in', r.rows?.[0]?.new === true, r)
check('a second check-in is a no-op', (await checkIn('p1', 'now', { code })).rows?.[0]?.new === false)
check('the QR code works from anywhere', (await checkIn('p2', 'now', { code })).rows?.[0]?.new === true)
check('direct check-in writes blocked', !!(await as('p1', {}, `insert into event_checkins (event_id, player_id) select 'later', id from players limit 1`)).error)
r = await as('p1', {}, `select event_id from event_checkins order by 1`)
check('a player reads only their own check-ins', JSON.stringify(r.rows) === '[{"event_id":"now"}]', r)

// A drop seeded from an event: checking in there checks you in to the event.
const drop = (await admin(`insert into drops (title, type, lat, lng, source_id, expires_at) values ('Chess', 'checkin', $1, $2, 'discover:later', now() + interval '3 days') returning id`, [LAT, LNG])).rows[0].id
await as('p1', {}, `select claim_drop($1, $2, $3)`, [drop, LAT, LNG])
check('checking in at a seeded drop checks in to its event', (await su(`select count(*)::int as n from event_checkins where event_id = 'later' and player_id = $1`, [await idOf('p1')]))[0].n === 1)

// Past visits (time travel) and RSVPs.
for (const [sub, id] of [['p1', 'past1'], ['p2', 'past1'], ['p3', 'past2']]) {
  await su(`insert into event_checkins (event_id, player_id) values ($1, $2)`, [id, await idOf(sub)])
}
for (const sub of ['p1', 'p2', 'p3']) await as(sub, {}, `select set_going('later', true)`)

// --- The dashboard
r = await as('p1', {}, `select club_stats('Chess Club') as s`)
check('players can’t see a club’s dashboard', /Only this club/.test(r.error ?? ''), r)
r = await as('org', {}, `select club_stats('Go Club') as s`)
check('nor organizers another club’s', /Only this club/.test(r.error ?? ''), r)
const stats = (await as('org', {}, `select club_stats('Chess Club') as s`)).rows?.[0]?.s
const byId = Object.fromEntries((stats?.events ?? []).map((e) => [e.id, e]))
// p1: past1, now, later. p2: past1, now. p3: past2, soon. Everyone came back.
check('attendees: everyone who checked in to any event', stats?.attendees === 3, stats)
check('returning: checked in to two or more of its events', stats?.returning === 3, stats)
check('totals', stats?.rsvps === 3 && stats.checkins === 7, stats)
check('each event’s RSVPs and check-ins', byId.later?.going === 3 && byId.later.checked_in === 1 && byId.now.checked_in === 2 && byId.past1.checked_in === 2, byId)
check('newest first, cancelled ones flagged', stats?.events[0].id === 'later' && byId.off?.cancelled === true, stats?.events.map((e) => e.id))
check('only this club’s events', !byId.rival, Object.keys(byId))
check('counts only: no player ids or names anywhere', !JSON.stringify(stats).includes(await idOf('p1')) && !/"p1"|display_name/.test(JSON.stringify(stats)))
check('admins see any club', !(await admin(`select club_stats('Go Club')`)).error)
check('anon can’t call club functions', !!(await db.exec('reset role').then(() => db.exec('set role anon')).then(() => db.query(`select club_stats('Chess Club')`)).catch((e) => e)).message)
await db.exec('reset role')

// --- History survives the sync's pruning
await su(`update discover_events set starts_at = now() - interval '41 days', ends_at = now() - interval '40 days' where id in ('past1', 'club0')`)
r = await server(`select sync_discover_events('[]'::jsonb, false)`)
const left = (await su(`select id from discover_events where id in ('past1', 'club0') order by id`)).map((x) => x.id)
check('an old event someone checked in to is kept; an empty one is pruned', !r.error && JSON.stringify(left) === '["past1"]', { r, left })

finish()
