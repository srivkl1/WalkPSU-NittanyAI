// Private player profiles (major and interests), and Discover's event benefits stored by the sync.
import { actor, check, createDb, finish, migrate, serviceRole, superuser } from './harness.mjs'

const db = await createDb()
await migrate(db)
const as = actor(db)
const su = superuser(db)
const server = serviceRole(db)

for (const n of ['p1', 'p2']) await as(n, {}, `insert into players (display_name) values ($1)`, [n])
const save = (sub, major, interests) =>
  as(sub, {}, `insert into player_profiles (player_id, major, interests) values (current_player_id(), $1, $2)
    on conflict (player_id) do update set major = excluded.major, interests = excluded.interests, updated_at = now() returning *`, [major, interests])

let r = await save('p1', 'Computer Science', ['tech', 'free_food'])
check('a player saves their profile', r.rows?.[0].major === 'Computer Science' && JSON.stringify(r.rows[0].interests) === '["tech","free_food"]', r)
r = await save('p1', 'Finance', ['career'])
check('and changes it', r.rows?.[0].major === 'Finance' && JSON.stringify(r.rows[0].interests) === '["career"]', r)
r = await as('p1', {}, `select major from player_profiles`)
check('they read it back', JSON.stringify(r.rows) === '[{"major":"Finance"}]', r)

await save('p2', null, ['sports'])
r = await as('p2', {}, `select player_id, major, interests from player_profiles`)
check('profiles are private: p2 sees only their own', r.rows?.length === 1 && JSON.stringify(r.rows[0].interests) === '["sports"]', r)
r = await as('p2', {}, `update player_profiles set major = 'hacked' where major = 'Finance'`)
check('and can’t change someone else’s (no rows touched)', !r.error && (await su(`select major from player_profiles where major = 'Finance'`)).length === 1, r)
r = await as('p2', {}, `insert into player_profiles (player_id, major) select id, 'fake' from players where auth_id = 'p1' on conflict do nothing`)
check('or write a profile for someone else', /row-level security|violates/.test(r.error ?? ''), r)
r = await as('p1', {}, `delete from player_profiles`)
check('deleting isn’t allowed (clear the fields instead)', /permission denied/.test(r.error ?? ''), r)

r = await save('p1', 'Finance', ['career', 'not_an_interest'])
check('only known interests', /check constraint/.test(r.error ?? ''), r)
r = await save('p1', 'x'.repeat(81), [])
check('a major is at most 80 characters', /check constraint/.test(r.error ?? ''), r)
r = await save('p1', '', [])
check('and not empty (null means none)', /check constraint/.test(r.error ?? ''), r)
r = await save('p1', null, [])
check('an empty profile is fine', !r.error, r)
r = await db.exec('reset role').then(() => db.exec('set role anon')).then(() => db.query(`select * from player_profiles`)).catch((e) => ({ error: e.message }))
await db.exec('reset role')
check('anon can’t read profiles', /permission denied/.test(r.error ?? ''), r)

await su(`delete from players where auth_id = 'p2'`)
check('a profile goes with its player', (await su(`select count(*)::int as n from player_profiles`))[0].n === 1)

// The sync now keeps Discover's benefits.
const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString()
r = await server(`select sync_discover_events($1::jsonb, false) as s`, [
  JSON.stringify([
    { id: 'pizza', title: 'Pizza Night', categories: ['Social Activities'], benefits: ['Free Food'], starts_at: hours(1), ends_at: hours(2) },
    { id: 'plain', title: 'Meeting', categories: [], starts_at: hours(1), ends_at: hours(2) },
  ]),
])
check('the sync still works', r.rows?.[0].s.events === 2, r)
const rows = await su(`select id, benefits from discover_events order by id`)
check('and stores benefits (empty when Discover sends none)', JSON.stringify(rows.map((x) => [x.id, x.benefits])) === '[["pizza",["Free Food"]],["plain",[]]]', rows)
r = await as('p1', {}, `select benefits from discover_events where id = 'pizza'`)
check('players can read them', JSON.stringify(r.rows) === '[{"benefits":["Free Food"]}]', r)
r = await as('p1', {}, `select sync_discover_events('[]'::jsonb, true)`)
check('the replaced sync is still service-only', /permission denied/.test(r.error ?? ''), r)

finish()
