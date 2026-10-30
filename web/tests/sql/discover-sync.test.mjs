// Live Penn State Discover sync: sync_discover_events (service role only), who can read discover_events and
// discover_locations, cancelling only on a complete fetch, and seeded drops following their event.
import { LAT, LNG, actor, check, createDb, finish, migrate, serviceRole, superuser } from './harness.mjs'

const db = await createDb()
await migrate(db)
const as = actor(db)
const su = superuser(db)
const server = serviceRole(db)

await as('p1', {}, `insert into players (display_name) values ('p1')`)

const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString()
const hub = { num: '0005000', name: 'HUB-Robeson Center', lat: LAT, lng: LNG, matched_by: 'location text' }
const event = (id, extra = {}) => ({
  id, title: `Event ${id}`, organization: 'Club', theme: 'Social', categories: ['Social Activities'],
  starts_at: hours(1), ends_at: hours(3), location: 'HUB 233', lat: null, lng: null, building: hub, ...extra,
})
const sync = (events, complete = true) => server(`select sync_discover_events($1::jsonb, $2) as s`, [JSON.stringify(events), complete])
const eventRow = async (id) => (await su(`select * from discover_events where id = $1`, [id]))[0]
const dropFor = async (id) => (await su(`select * from drops where source_id = $1`, [`discover:${id}`]))[0]

// --- Who may sync
let r = await as('p1', {}, `select sync_discover_events('[]'::jsonb, true)`)
check('players can’t sync events', /permission denied/.test(r.error ?? ''), r)
r = await server(`select sync_discover_events('{}'::jsonb, true)`)
check('p_events must be an array', /must be an array/.test(r.error ?? ''), r)

const online = event('c', { location: 'Zoom', building: null })
r = await sync([event('a'), event('b'), online, event('a')])
check('the server syncs a batch (a duplicate id counts once)', r.rows?.[0].s.events === 3, r)
const a = await eventRow('a')
check('stores the listing', a?.title === 'Event a' && a.organization === 'Club' && JSON.stringify(a.categories) === '["Social Activities"]' && a.location === 'HUB 233', a)
check('with its building', a?.building?.num === '0005000' && a.building.matched_by === 'location text', a?.building)
check('an online event has no building (null, not JSON null)', (await su(`select building is null as ok from discover_events where id = 'c'`))[0].ok)
check('lat and lng are not stored', !('lat' in a) && !('lng' in a), Object.keys(a))

// --- Who may read
r = await as('p1', {}, `select id from discover_events order by id`)
check('players can read events', JSON.stringify(r.rows?.map((x) => x.id)) === '["a","b","c"]', r)
r = await as('p1', {}, `update discover_events set title = 'hacked'`)
check('but not change them', /permission denied/.test(r.error ?? ''), r)
r = await as('p1', {}, `insert into discover_events (id, title, starts_at, ends_at) values ('x', 'fake', now(), now())`)
check('or add them', /permission denied/.test(r.error ?? ''), r)
r = await db.exec('reset role').then(() => db.exec('set role anon')).then(() => db.query(`select * from discover_events`)).catch((e) => ({ error: e.message }))
await db.exec('reset role')
check('anon can’t read events', /permission denied/.test(r.error ?? ''), r)

r = await server(`insert into discover_locations (location, building_num) values ('340 hhd', '0257000'), ('sunset park', null)`)
check('the server caches Gemini’s placements', !r.error, r)
r = await server(`select location, building_num from discover_locations order by location`)
check('and reads them back', r.rows?.length === 2 && r.rows[0].building_num === '0257000', r)
r = await as('p1', {}, `select * from discover_locations`)
check('players can’t read the location cache', /permission denied/.test(r.error ?? ''), r)

// --- Seeded drops follow their event
const seed = (id) =>
  su(`insert into drops (title, type, lat, lng, points, starts_at, expires_at, source_id) select title, 'checkin', $2, $3, 15, starts_at, ends_at, 'discover:' || id from discover_events where id = $1 returning id`, [id, LAT, LNG])
const dropA = (await seed('a'))[0].id
const dropB = (await seed('b'))[0].id
const p1 = (await su(`select id from players where auth_id = 'p1'`))[0].id
await su(`insert into claims (drop_id, player_id, points) values ($1, $2, 15)`, [dropB, p1])

// A truncated fetch: a moved, b missing.
const moved = event('a', { starts_at: hours(5), ends_at: hours(7) })
r = await sync([moved, online], false)
check('a truncated fetch cancels nothing', r.rows?.[0].s.cancelled === 0 && (await eventRow('b')).cancelled === false, r)
check('a rescheduled event moves its drop', r.rows?.[0].s.drops_rescheduled === 1, r)
let d = await dropFor('a')
check('to the new times', d.starts_at.getTime() === Date.parse(moved.starts_at) && d.expires_at.getTime() === Date.parse(moved.ends_at), d)

// A complete fetch without b: b was cancelled.
r = await sync([moved, online], true)
check('a complete fetch cancels the missing upcoming event', r.rows?.[0].s.cancelled === 1 && (await eventRow('b')).cancelled === true, r)
check('and closes its drop', r.rows?.[0].s.drops_closed === 1, r)
d = await dropFor('b')
check('as expired, not deleted', d?.status === 'expired' && d.expires_at.getTime() <= Date.now() + 1000, d)
check('so check-ins already made stay', (await su(`select count(*)::int as n from claims where drop_id = $1`, [dropB]))[0].n === 1)
check('the other event and its drop are untouched', (await eventRow('a')).cancelled === false && (await dropFor('a')).status === 'active')
r = await as('p1', {}, `select id from discover_events where not cancelled order by id`)
check('players see which events are cancelled', JSON.stringify(r.rows?.map((x) => x.id)) === '["a","c"]', r)

r = await sync([moved, online], true)
check('a sync with no changes reschedules and closes nothing', r.rows?.[0].s.drops_rescheduled === 0 && r.rows[0].s.drops_closed === 0, r)

// b comes back (un-cancelled): the event is live again, but its closed drop stays closed.
r = await sync([moved, online, event('b', { starts_at: hours(2), ends_at: hours(4) })], true)
check('an event that reappears is un-cancelled', (await eventRow('b')).cancelled === false, r)
check('but a closed drop stays closed', (await dropFor('b')).status === 'expired')

// An admin closed a's drop; a reschedule doesn't reopen or move it.
await su(`update drops set status = 'expired' where id = $1`, [dropA])
const before = await dropFor('a')
await sync([event('a', { starts_at: hours(8), ends_at: hours(9) }), online, event('b')], true)
check('a closed drop isn’t moved by a reschedule', (await dropFor('a')).expires_at.getTime() === before.expires_at.getTime())

// An event that has ended drops out of Discover's feed: that's not a cancellation.
await su(`update discover_events set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' where id = 'c'`)
await sync([event('a'), event('b')], true)
check('an ended event missing from the feed isn’t cancelled', (await eventRow('c')).cancelled === false)

// History older than a month is pruned.
await su(`update discover_events set starts_at = now() - interval '41 days', ends_at = now() - interval '40 days' where id = 'c'`)
await sync([event('a'), event('b')], true)
check('events that ended over 30 days ago are removed', (await eventRow('c')) === undefined)

check('player-facing columns hold no description or contact fields', (await su(`select column_name from information_schema.columns where table_name = 'discover_events'`)).every((c) => !/descr|contact|email|attendee/.test(c.column_name)))

finish()
