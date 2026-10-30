// Player meetups (a social pin, nothing to check in to) and close_drop (admins clear any drop; players end their own meetup).
import { LAT, LNG, actor, check, createDb, finish, migrate, superuser } from './harness.mjs'

const db = await createDb()
await migrate(db)
const as = actor(db)
const su = superuser(db)
const admin = (q, p) => as('admin', { app_role: 'admin' }, q, p)

for (const n of ['p1', 'p2']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
await as('admin', { app_role: 'admin' }, `insert into players (display_name) values ('Org')`)
const meetup = (sub, text, lat = LAT, lng = LNG, minutes = 60) =>
  as(sub, {}, `select * from create_meetup($1, $2, $3, $4)`, [text, lat, lng, minutes])
const dropRow = async (id) => (await su(`select * from drops where id = $1`, [id]))[0]

// --- Posting
let r = await meetup('p1', '  Volleyball on the HUB lawn, come play!  ')
const m1 = r.rows?.[0]
check('a player can post a meetup', m1?.type === 'meetup' && m1.title === 'Volleyball on the HUB lawn, come play!', r)
check('it says who started it', m1?.subtitle === 'Started by p1', m1)
check('it expires after the chosen time', Math.abs(Date.parse(m1.expires_at) - Date.parse(m1.created_at) - 60 * 60_000) < 5000, m1)
check('it gets a QR secret like any drop (trigger)', (await su(`select count(*)::int as n from drop_secrets where drop_id = $1`, [m1.id]))[0].n === 1)

r = await meetup('p1', 'yo')
check('text must be 3+ characters', /3 to 80/.test(r.error ?? ''), r)
r = await meetup('p1', 'x'.repeat(81))
check('text must be at most 80 characters', /3 to 80/.test(r.error ?? ''), r)
r = await meetup('p1', 'Frisbee', null, null)
check('needs a location', /location/.test(r.error ?? ''), r)
r = await meetup('p1', 'Frisbee in Pittsburgh', 40.4406, -79.9959)
check('must be on campus', /on campus/.test(r.error ?? ''), r)
r = await meetup('ghost', 'Frisbee')
check('must have joined', /Join the game/.test(r.error ?? ''), r)

r = await meetup('p1', 'Quick game', LAT, LNG, 5)
const m2 = r.rows?.[0]
check('duration is clamped to at least 15 minutes', Date.parse(m2.expires_at) - Date.parse(m2.created_at) >= 15 * 60_000 - 5000, m2)
check('posting again replaces my previous meetup', (await dropRow(m1.id)).status === 'expired' && m2.status === 'active')
r = await meetup('p1', 'All day thing', LAT, LNG, 10_000)
const m3 = r.rows?.[0]
check('and at most 3 hours', Date.parse(m3.expires_at) - Date.parse(m3.created_at) <= 180 * 60_000 + 5000, m3)

await meetup('p1', 'Number four')
await meetup('p1', 'Number five')
r = await meetup('p1', 'Number six')
check('at most 5 meetups an hour', /lot of meetups/.test(r.error ?? ''), r)

// --- Nothing to check in to
const live = (await su(`select id from drops where type = 'meetup' and status = 'active' and created_by = (select id from players where auth_id = 'p1')`))[0].id
r = await as('p2', {}, `select * from claim_drop($1, $2, $3)`, [live, LAT, LNG])
check('nobody checks in to a meetup', /nothing to check in to/.test(r.error ?? ''), r)
const code = (await su(`select claim_code from drop_secrets where drop_id = $1`, [live]))[0].claim_code
r = await as('p2', {}, `select * from claim_drop($1, null, null, $2)`, [live, code])
check('not even by QR', /nothing to check in to/.test(r.error ?? ''), r)

// --- Direct inserts are still admin-only
r = await as('p2', {}, `insert into drops (title, type, lat, lng) values ('sneaky', 'meetup', $1, $2)`, [LAT, LNG])
check('players can’t insert drops directly', /row-level security/.test(r.error ?? ''), r)

// --- Closing
r = await as('p2', {}, `select close_drop($1)`, [live])
check('another player can’t end my meetup', /Only admins/.test(r.error ?? ''), r)
r = await as('p1', {}, `select close_drop($1)`, [live])
check('I can end my own meetup', !r.error && (await dropRow(live)).status === 'expired', r)

const checkin = (await admin(`insert into drops (title, type, lat, lng, points) values ('Old Main', 'checkin', $1, $2, 15) returning id`, [LAT, LNG])).rows[0].id
await as('p2', {}, `select * from claim_drop($1, $2, $3)`, [checkin, LAT, LNG])
const checkin2 = (await admin(`insert into drops (title, type, lat, lng) values ('HUB', 'checkin', $1, $2) returning id`, [LAT, LNG])).rows[0].id
r = await as('p1', {}, `select close_drop($1)`, [checkin2])
check('a player can’t clear an admin’s drop', /Only admins/.test(r.error ?? ''), r)
r = await admin(`select close_drop($1)`, [checkin2])
const cleared = await dropRow(checkin2)
check('an admin can clear any drop', !r.error && cleared.status === 'expired' && Date.parse(cleared.expires_at) <= Date.now() + 1000, r)
r = await admin(`select close_drop($1)`, [checkin])
const kept = (await su(`select count(*)::int as n from claims where drop_id = $1`, [checkin]))[0].n
check('clearing a drop keeps its check-ins', !r.error && kept === 1, { r, kept })
r = await as('p1', {}, `select close_drop('00000000-0000-0000-0000-000000000000')`)
check('unknown drop', /not found/.test(r.error ?? ''), r)
r = await db.exec('reset role').then(() => db.exec('set role anon')).then(() => db.query(`select close_drop($1)`, [checkin])).catch((e) => ({ error: e.message }))
await db.exec('reset role')
check('anon can’t call close_drop', /permission denied/.test(r.error ?? ''), r)

finish()
