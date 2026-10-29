// Today's behavior with every migration applied: joining, RLS, drops, checking in, and QR codes.
import { LAT, LNG, M_PER_DEG_LAT, actor, check, createDb, finish, migrate, superuser } from './harness.mjs'

const db = await createDb()
await migrate(db)
const as = actor(db)
const su = superuser(db)
const admin = (q, p) => as('admin', { app_role: 'admin' }, q, p)
const mkDrop = async (type, { building = null, points = 25, lat = LAT, lng = LNG, expired = false } = {}) =>
  (await admin(
    `insert into drops (title, type, lat, lng, points, building_num, expires_at)
     values ('d', $1, $2, $3, $4, $5, case when $6 then now() - interval '1 minute' end) returning id`,
    [type, lat, lng, points, building, expired],
  )).rows[0].id

// --- Schema shape
check('no teams table', (await su(`select to_regclass('public.teams') as t`))[0].t === null)
check('no building_control table', (await su(`select to_regclass('public.building_control') as t`))[0].t === null)
check('no team_id columns', (await su(`select count(*)::int as n from information_schema.columns where table_schema = 'public' and column_name = 'team_id'`))[0].n === 0)
check('no player_scores view', (await su(`select to_regclass('public.player_scores') as t`))[0].t === null)

// --- Players
for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
let r = await as('p1', {}, `select auth_id, color, is_admin from players where display_name = 'p1'`)
check('join with just a name: auth_id from JWT, color assigned, not admin', r.rows?.[0]?.auth_id === 'p1' && /^#[0-9a-f]{6}$/.test(r.rows[0].color) && r.rows[0].is_admin === false, r)
const colors = (await su(`select color from players`)).map((x) => x.color)
check('first players get distinct colors', new Set(colors).size === colors.length, colors)
check('cannot spoof auth_id', !!(await as('x', {}, `insert into players (display_name, auth_id) values ('x', 'p1')`)).error)
check('cannot choose own color', !!(await as('x', {}, `insert into players (display_name, color) values ('x', '#000000')`)).error)
check('cannot self-grant admin', !!(await as('x', {}, `insert into players (display_name, is_admin) values ('x', true)`)).error)
check("cannot rename someone else", (await as('p2', {}, `update players set display_name = 'hacked' where auth_id = 'p1' returning id`)).rows?.length === 0)

// --- Drops and admin rules
check('non-admin cannot insert drops', !!(await as('p1', {}, `insert into drops (title, type, lat, lng) values ('x', 'checkin', 0, 0)`)).error)
check('Auth0 admin claim can insert drops', !!(await mkDrop('checkin')))
await su(`update players set is_admin = true where auth_id = 'p6'`)
check('players.is_admin can insert drops', !!(await as('p6', {}, `insert into drops (title, type, lat, lng) values ('x', 'checkin', $1, $2) returning id`, [LAT, LNG])).rows)
await su(`update players set is_admin = false where auth_id = 'p6'`)

// --- Imported event drops (scripts/seed-event-drops.mjs)
const eventDrop = (source) =>
  admin(
    `insert into drops (title, type, lat, lng, subtitle, starts_at, expires_at, source_id)
     values ('Haunted House', 'checkin', $1, $2, 'Forensic Science Club', now() + interval '1 hour', now() + interval '3 hours', $3) returning id`,
    [LAT, LNG, source],
  )
const imported = (await eventDrop('discover:1')).rows?.[0]?.id
check('admin can insert an event drop with subtitle, start time and source', !!imported)
r = await as('p1', {}, `select subtitle, starts_at < expires_at as ordered, source_id from drops where id = $1`, [imported])
check('players read the subtitle and start time', r.rows?.[0]?.subtitle === 'Forensic Science Club' && r.rows[0].ordered && r.rows[0].source_id === 'discover:1', r)
check('the same event cannot be imported twice', /unique|duplicate/.test((await eventDrop('discover:1')).error ?? ''))
check('drops made in /admin have no source', (await su(`select count(*)::int as n from drops where source_id is null`))[0].n >= 2)
check('players cannot clear imported drops', (await as('p1', {}, `delete from drops where source_id is not null returning id`)).rows?.length === 0)
await admin(`delete from drops where source_id like 'discover:%'`)
check('clearing imports leaves admin-made drops', (await su(`select count(*)::int as n from drops where source_id is not null`))[0].n === 0 && (await su(`select count(*)::int as n from drops`))[0].n >= 2)

// --- Checking in
check('claim_radius_m() = 60', (await as('p1', {}, `select claim_radius_m() as m`)).rows[0].m === 60)
const plain = await mkDrop('checkin', { building: '0001000' })
check('direct claim insert blocked', !!(await as('p1', {}, `insert into claims (drop_id, player_id) select $1, id from players limit 1`, [plain])).error)
r = await as('p1', {}, `select * from claim_drop($1, $2, $3)`, [plain, LAT + 61 / M_PER_DEG_LAT, LNG])
check('61 m away rejected', /closer/.test(r.error ?? ''), r)
r = await as('p1', {}, `select * from claim_drop($1)`, [plain])
check('no GPS and no code rejected', /QR/.test(r.error ?? ''), r)
r = await as('p1', {}, `select * from claim_drop($1, $2, $3)`, [plain, LAT + 59 / M_PER_DEG_LAT, LNG])
check('59 m away accepted', !!r.rows?.[0]?.id, r)
check('the drop stays open for the next person', (await su(`select status from drops where id = $1`, [plain]))[0].status === 'active')
r = await as('p2', {}, `select * from claim_drop($1, $2, $3)`, [plain, LAT, LNG])
check('a second player checks in too', !!r.rows?.[0]?.id, r)
r = await as('p1', {}, `select * from claim_drop($1, $2, $3)`, [plain, LAT, LNG])
check('but nobody checks in twice', /already checked in/.test(r.error ?? ''), r)
check('two check-ins recorded', (await su(`select count(*)::int as n from claims where drop_id = $1`, [plain]))[0].n === 2)
r = await as('p2', {}, `select * from claim_drop($1, $2, $3)`, [await mkDrop('checkin', { expired: true }), LAT, LNG])
check('expired drop rejected', /no longer available/.test(r.error ?? ''), r)
r = await as('nobody', {}, `select * from claim_drop($1, $2, $3)`, [await mkDrop('checkin'), LAT, LNG])
check('check-in before joining rejected', /Join before/.test(r.error ?? ''), r)

// --- QR codes
const qrDrop = await mkDrop('checkin', { lat: LAT + 0.02 })
const code = (await admin(`select claim_code from drop_secrets where drop_id = $1`, [qrDrop])).rows[0]?.claim_code
check('every drop gets a 32-char claim code', code?.length === 32, code)
check('players cannot read claim codes', (await as('p2', {}, `select * from drop_secrets`)).rows?.length === 0)
r = await as('p2', {}, `select * from claim_drop(p_drop_id => $1, p_code => 'wrong')`, [qrDrop])
check('wrong QR code rejected', /match/.test(r.error ?? ''), r)
r = await as('p2', {}, `select * from claim_drop(p_drop_id => $1, p_code => $2)`, [qrDrop, code])
check('QR code checks in from any distance', !!r.rows?.[0]?.id, r)

// --- Mini-games, photo hunts and points are gone
const gone = ['join_game', 'start_game', 'submit_shakes', 'finish_game', 'get_game_state', 'submit_dodges', 'submit_reaction', 'submit_heading', 'create_photo_hunt', 'claim_photo_hunt', 'photo_hunt_check']
const left = (await su(`select proname from pg_proc where proname = any($1)`, [gone])).map((x) => x.proname)
check('the game and hunt functions are dropped', left.length === 0, left)
for (const type of ['minigame', 'photo_hunt']) {
  r = await admin(`insert into drops (title, type, lat, lng) values ('x', $1, $2, $3) returning id`, [type, LAT, LNG])
  check(`even an admin can’t drop a new ${type}`, /removed/.test(r.error ?? ''), r)
}
r = await admin(`update drops set type = 'minigame' where id = $1 returning id`, [plain])
check('nor turn a check-in into one', /removed/.test(r.error ?? ''), r)
finish()
