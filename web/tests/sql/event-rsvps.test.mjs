// WalkPSU's own event RSVPs: set_going toggles, event_going returns counts (never who), and players read only their
// own rows.
import { actor, check, createDb, finish, migrate, superuser } from './harness.mjs'

const db = await createDb()
await migrate(db)
const as = actor(db)
const su = superuser(db)

for (const n of ['p1', 'p2', 'p3']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
await su(`
  insert into discover_events (id, title, starts_at, ends_at, cancelled) values
    ('soon', 'Soon', now() + interval '1 hour', now() + interval '3 hours', false),
    ('other', 'Other', now() + interval '1 day', now() + interval '1 day 2 hours', false),
    ('over', 'Over', now() - interval '3 hours', now() - interval '1 hour', false),
    ('gone', 'Cancelled', now() + interval '1 hour', now() + interval '2 hours', true)
`)
const go = (sub, id, going = true) => as(sub, {}, `select set_going($1, $2) as n`, [id, going])
const counts = async (sub, ids) =>
  Object.fromEntries(((await as(sub, {}, `select * from event_going($1)`, [ids])).rows ?? []).map((r) => [r.event_id, { going: r.going, me: r.me }]))

let r = await go('p1', 'soon')
check('a player RSVPs; the new count comes back', r.rows?.[0].n === 1, r)
check('RSVPing twice counts once', (await go('p1', 'soon')).rows?.[0].n === 1)
check('another player adds to it', (await go('p2', 'soon')).rows?.[0].n === 2)

let c = await counts('p1', ['soon', 'other'])
check('event_going: counts, and whether I’m going', c.soon?.going === 2 && c.soon.me === true && c.other?.going === 0 && c.other.me === false, c)
c = await counts('p3', ['soon'])
check('someone not going sees the count with me = false', c.soon?.going === 2 && c.soon.me === false, c)
c = await counts('p1', ['nope'])
check('unknown events are left out', Object.keys(c).length === 0, c)
const cols = (await as('p1', {}, `select * from event_going(array['soon'])`)).rows?.[0]
check('event_going never says who', JSON.stringify(Object.keys(cols ?? {}).sort()) === '["event_id","going","me"]', cols)

r = await go('p1', 'soon', false)
check('un-RSVPing drops the count', r.rows?.[0].n === 1, r)
check('un-RSVPing when not going is harmless', (await go('p3', 'soon', false)).rows?.[0].n === 1)

r = await go('p1', 'over')
check('can’t RSVP to an event that’s over', /over/.test(r.error ?? ''), r)
r = await go('p1', 'gone')
check('or one that was cancelled', /cancelled/.test(r.error ?? ''), r)
r = await go('p1', 'nope')
check('or one that doesn’t exist', /not found/.test(r.error ?? ''), r)
r = await go('stranger', 'soon')
check('must have joined', /Join the game/.test(r.error ?? ''), r)

r = await as('p2', {}, `select event_id from event_rsvps`)
check('a player reads only their own RSVPs', JSON.stringify(r.rows) === '[{"event_id":"soon"}]', r)
r = await as('p1', {}, `select * from event_rsvps`)
check('so nobody can list who else is going', r.rows?.length === 0, r)
r = await as('p1', {}, `insert into event_rsvps (event_id, player_id) select 'other', id from players where auth_id = 'p3'`)
check('no direct inserts (can’t RSVP someone else)', /permission denied/.test(r.error ?? ''), r)
r = await as('p2', {}, `delete from event_rsvps`)
check('no direct deletes', /permission denied/.test(r.error ?? ''), r)
r = await db.exec('reset role').then(() => db.exec('set role anon')).then(() => db.query(`select * from event_going(array['soon'])`)).catch((e) => ({ error: e.message }))
await db.exec('reset role')
check('anon can’t read counts', /permission denied/.test(r.error ?? ''), r)

await su(`delete from discover_events where id = 'soon'`)
check('RSVPs go with their event', (await su(`select count(*)::int as n from event_rsvps`))[0].n === 0)
await go('p3', 'other')
await su(`delete from players where auth_id = 'p3'`)
check('and with their player', (await su(`select count(*)::int as n from event_rsvps`))[0].n === 0)

finish()
