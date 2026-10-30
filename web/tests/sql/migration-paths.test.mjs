// Upgrades that rewrite existing data: build state under an older schema, migrate, and check nothing is lost.
import { LAT, LNG, MIGRATIONS, actor, check, createDb, finish, migrate, superuser } from './harness.mjs'

const INDIVIDUAL = MIGRATIONS.find((m) => m.includes('individual_players'))
const REMOVE_CAPTURE = MIGRATIONS.find((m) => m.includes('remove_building_capture'))
const beforeIndividual = MIGRATIONS[MIGRATIONS.indexOf(INDIVIDUAL) - 1]
const beforeRemoval = MIGRATIONS[MIGRATIONS.indexOf(REMOVE_CAPTURE) - 1]
const PHOTO_HUNT = MIGRATIONS.find((m) => m.includes('photo_hunt'))
const beforePhotoHunt = MIGRATIONS[MIGRATIONS.indexOf(PHOTO_HUNT) - 1]
const NEEDLE = MIGRATIONS.find((m) => m.includes('needle_rain'))
const beforeNeedle = MIGRATIONS[MIGRATIONS.indexOf(NEEDLE) - 1]
const QUICK_DRAW = MIGRATIONS.find((m) => m.includes('quick_draw'))
const beforeQuickDraw = MIGRATIONS[MIGRATIONS.indexOf(QUICK_DRAW) - 1]
const REMOVE_GAMES = MIGRATIONS.find((m) => m.includes('remove_games_and_points'))
const beforeRemoveGames = MIGRATIONS[MIGRATIONS.indexOf(REMOVE_GAMES) - 1]

// --- Teams → individual players
{
  const db = await createDb()
  await migrate(db, { until: beforeIndividual })
  const as = actor(db)
  const su = superuser(db)
  const teams = (await su(`select id from teams order by name`)).map((t) => t.id)
  await as('alice', {}, `insert into players (display_name, team_id) values ('Alice', $1)`, [teams[0]])
  await as('bob', {}, `insert into players (display_name, team_id) values ('Bob', $1)`, [teams[1]])
  const drop = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng, points, building_num) values ('Old', 'checkin', $1, $2, 20, '0001000') returning id`, [LAT, LNG])).rows[0].id
  check('setup: team-era claim captures a building', !!(await as('alice', {}, `select * from claim_drop($1, $2, $3)`, [drop, LAT, LNG])).rows)

  await migrate(db, { from: INDIVIDUAL, until: INDIVIDUAL })
  const players = await su(`select display_name, color from players order by created_at`)
  check('existing players get distinct colors', players.length === 2 && players[0].color !== players[1].color && players.every((p) => /^#[0-9a-f]{6}$/.test(p.color)), players)
  const control = await su(`select p.display_name from building_control b join players p on p.id = b.player_id`)
  check('captured building moves to the capturing player', control[0]?.display_name === 'Alice', control)
  check('team columns and table gone', (await su(`select to_regclass('public.teams') as t`))[0].t === null)
  check('the claim (and its points) survive', (await su(`select count(*)::int as n from claims`))[0].n === 1)
}

// --- Building capture removal
{
  const db = await createDb()
  await migrate(db, { until: beforeRemoval })
  const as = actor(db)
  const su = superuser(db)
  await as('a', {}, `insert into players (display_name) values ('a')`)
  const drop = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng, points, building_num) values ('d', 'checkin', $1, $2, 20, '0001000') returning id`, [LAT, LNG])).rows[0].id
  await as('a', {}, `select * from claim_drop($1, $2, $3)`, [drop, LAT, LNG])
  check('setup: capture recorded before removal', (await su(`select count(*)::int as n from building_control`))[0].n === 1)

  await migrate(db, { from: REMOVE_CAPTURE, until: REMOVE_CAPTURE })
  check('building_control dropped', (await su(`select to_regclass('public.building_control') as t`))[0].t === null)
  check('and left the realtime publication', (await su(`select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'building_control'`))[0].n === 0)
  const score = (await as('a', {}, `select points, claims from player_scores`)).rows?.[0]
  check('earlier points survive', score?.points === 20 && score.claims === 1, score)
  check('drops.building_num kept', (await su(`select building_num from drops where id = $1`, [drop]))[0].building_num === '0001000')
}

// --- Per-claim points (photo hunts)
{
  const db = await createDb()
  await migrate(db, { until: beforePhotoHunt })
  const as = actor(db)
  const su = superuser(db)
  await as('a', {}, `insert into players (display_name) values ('a')`)
  const drop = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng, points) values ('d', 'checkin', $1, $2, 20) returning id`, [LAT, LNG])).rows[0].id
  await as('a', {}, `select * from claim_drop($1, $2, $3)`, [drop, LAT, LNG])

  await migrate(db, { from: PHOTO_HUNT, until: PHOTO_HUNT })
  check('existing claims get their drop’s points', (await su(`select points from claims`))[0].points === 20)
  const score = (await as('a', {}, `select points, claims from player_scores`)).rows?.[0]
  check('scores unchanged by the upgrade', score?.points === 20 && score.claims === 1, score)
  const later = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng, points) values ('e', 'checkin', $1, $2, 7) returning id`, [LAT, LNG])).rows[0].id
  await su(`insert into claims (drop_id, player_id) select $1, id from players`, [later])
  check('claims inserted without points (claim_drop, finish_game) default to the drop’s', (await su(`select points from claims where drop_id = $1`, [later]))[0].points === 7)
}

// --- Mini-game kinds (Quick Draw)
{
  const db = await createDb()
  await migrate(db, { until: beforeQuickDraw })
  const as = actor(db)
  const su = superuser(db)
  for (const n of ['a', 'b']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
  const game = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng, points) values ('g', 'minigame', $1, $2, 30) returning id`, [LAT, LNG])).rows[0].id
  const plain = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng) values ('c', 'checkin', $1, $2) returning id`, [LAT, LNG])).rows[0].id
  for (const n of ['a', 'b']) await as(n, {}, `select join_game($1, $2, $3)`, [game, LAT, LNG])
  await as('admin', { app_role: 'admin' }, `select start_game($1)`, [game])
  await su(`update games set started_at = now() - interval '5 seconds' where drop_id = $1`, [game])
  await as('a', {}, `select submit_shakes($1, 30)`, [game])

  await migrate(db, { from: QUICK_DRAW, until: QUICK_DRAW })
  const kinds = await su(`select id, game from drops`)
  check('existing minigame drops become Shake-Offs', kinds.find((d) => d.id === game).game === 'shake_off' && kinds.find((d) => d.id === plain).game === null, kinds)
  const s = (await as('a', {}, `select get_game_state($1) as s`, [game])).rows[0].s
  check('a Shake-Off in progress keeps its players, sides and shakes', s.kind === 'shake_off' && s.players.length === 2 && s.players.every((p) => p.side) && s.players.some((p) => p.shakes === 30), s)
  check('and still takes shakes', !(await as('b', {}, `select submit_shakes($1, 10)`, [game])).error)
}

// --- Needle Rain widens the game check without retconning existing rows.
{
  const db = await createDb()
  await migrate(db, { until: beforeNeedle })
  const as = actor(db)
  const su = superuser(db)
  const shake = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng, points) values ('s', 'minigame', $1, $2, 10) returning id`, [LAT, LNG])).rows[0].id
  const draw = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, game, lat, lng, points) values ('q', 'minigame', 'quick_draw', $1, $2, 10) returning id`, [LAT, LNG])).rows[0].id
  const plain = (await as('admin', { app_role: 'admin' }, `insert into drops (title, type, lat, lng) values ('c', 'checkin', $1, $2) returning id`, [LAT, LNG])).rows[0].id

  await migrate(db, { from: NEEDLE, until: NEEDLE })
  const kinds = await su(`select id, game from drops`)
  check('Needle Rain leaves existing games as they were', kinds.find((d) => d.id === shake).game === 'shake_off' && kinds.find((d) => d.id === draw).game === 'quick_draw' && kinds.find((d) => d.id === plain).game === null, kinds)
}

// --- Mini-games, photo hunts and points removed: live games close, live check-ins reopen, nothing is deleted.
{
  const db = await createDb()
  await migrate(db, { until: beforeRemoveGames })
  const as = actor(db)
  const su = superuser(db)
  const admin = (q, p) => as('admin', { app_role: 'admin' }, q, p)
  for (const n of ['a', 'b']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
  const game = (await admin(`insert into drops (title, type, lat, lng, points) values ('g', 'minigame', $1, $2, 30) returning id`, [LAT, LNG])).rows[0].id
  const hunt = (await admin(`select (create_photo_hunt('h', $1, $2, 'x.jpg', 'with a thumbs up')).id`, [LAT, LNG])).rows[0].id
  const live = (await admin(`insert into drops (title, type, lat, lng, expires_at) values ('live', 'checkin', $1, $2, now() + interval '2 hours') returning id`, [LAT, LNG])).rows[0].id
  const forever = (await admin(`insert into drops (title, type, lat, lng) values ('old demo', 'checkin', $1, $2) returning id`, [LAT, LNG])).rows[0].id
  for (const id of [live, forever]) await as('a', {}, `select claim_drop($1, $2, $3)`, [id, LAT, LNG])

  await migrate(db, { from: REMOVE_GAMES, until: REMOVE_GAMES })
  const status = Object.fromEntries((await su(`select id, status from drops`)).map((d) => [d.id, d.status]))
  check('live games and hunts close', status[game] === 'expired' && status[hunt] === 'expired', status)
  check('a claimed check-in that hasn’t ended reopens for everyone', status[live] === 'active', status)
  check('one with no end time stays closed, so old demo drops don’t come back', status[forever] === 'claimed', status)
  check('every old claim is kept', (await su(`select count(*)::int as n from claims`))[0].n === 2)
  check('and the game tables stay', (await su(`select to_regclass('public.games') as t`))[0].t !== null)
  check('player b can now check in where a already did', !(await as('b', {}, `select claim_drop($1, $2, $3)`, [live, LAT, LNG])).error)
}

finish()
