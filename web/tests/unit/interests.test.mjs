// "For you" matching (src/lib/interests.ts): interests against Discover's categories, themes, benefits, and title
// words; majors by word stem; hinted interests; ranking. Also that the interest ids match the migration's check.
import { readFileSync } from 'node:fs'
import { INTERESTS, forYou, majorStems, matchEvent } from '../../src/lib/interests.ts'

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)}`)
  if (!ok) failures++
}

const event = (title, extra = {}) => ({ title, organization: null, theme: null, categories: [], benefits: [], ...extra })
const me = (interests, major = null) => ({ interests, major })

check('major stems drop generic words and keep useful roots', JSON.stringify(majorStems('Mechanical Engineering')) === '["mechani","engineer"]', majorStems('Mechanical Engineering'))
check('short majors keep a 4-letter root', JSON.stringify(majorStems('Nursing')) === '["nurs"]', majorStems('Nursing'))
check('"Computer Science" never matches on "science"', !majorStems('Computer Science').some((s) => s.startsWith('scien')), majorStems('Computer Science'))
check('no major, no stems', majorStems(null).length === 0 && majorStems('  ').length === 0)

let m = matchEvent(event('General Meeting', { benefits: ['Free Food'] }), me(['free_food']))
check('Discover’s "Free Food" benefit matches free food, whatever the title', m.score > 0 && m.reasons[0] === 'Free food', m)
m = matchEvent(event('Late Night Pizza'), me(['free_food']))
check('so do food words in the title', m.score > 0, m)
m = matchEvent(event('Résumé Review', { categories: ['Career Exploration'] }), me(['career']))
check('a Discover category matches its interest', m.reasons.includes('Career'), m)
m = matchEvent(event('Open Mic', { theme: 'Arts' }), me(['arts']))
check('so does a Discover theme', m.reasons.includes('Arts & music'), m)
m = matchEvent(event('Spring Hackathon Kickoff'), me(['tech']))
check('tech (no Discover category) matches title words', m.reasons.includes('Tech'), m)
m = matchEvent(event('Department Mixer'), me(['arts']))
check('"art" inside another word doesn’t count', !m.reasons.includes('Arts & music'), m)

m = matchEvent(event('Meet the Firms', { organization: 'Society of Women Engineers' }), me([], 'Mechanical Engineering'))
check('a major matches a club by word stem', m.score > 0 && m.reasons.includes('Mechanical Engineering'), m)
m = matchEvent(event('Intro to Python Coding'), me([], 'Computer Science'))
check('a major hints at a related interest, for less', m.score === 1 && m.reasons.includes('Tech'), m)
m = matchEvent(event('Intro to Python Coding'), me(['tech'], 'Computer Science'))
check('a picked interest isn’t counted twice through a hint', m.score === 3 && m.reasons.filter((r) => r === 'Tech').length === 1, m)
m = matchEvent(event('Watercolor Night'), me([], 'Earth Sciences'))
check('"Earth" doesn’t hint at arts', m.score === 0, m)

m = matchEvent(event('Quiet Study Hall'), me(['sports', 'faith']))
check('no match: score 0', m.score === 0 && m.reasons.length === 0, m)
check('an unknown interest id is ignored', matchEvent(event('Pizza'), me(['nope'])).score === 0)

const events = [
  event('Board Game Night', { theme: 'Social' }),
  event('Career Fair', { categories: ['Career Exploration'], benefits: ['Free Food'] }),
  event('Knitting Circle'),
  event('Networking Night'),
]
const picks = forYou(events, me(['career', 'free_food', 'social']))
check('For you: best match first, then soonest; non-matches left out', JSON.stringify(picks.map((e) => e.title)) === '["Career Fair","Board Game Night","Networking Night"]', picks.map((e) => e.title))
check('each pick says why', JSON.stringify(picks[0].match.reasons) === '["Career","Free food"]', picks[0].match)
check('limit applies', forYou(events, me(['career', 'free_food', 'social']), 1).length === 1)
check('an empty profile picks nothing', forYou(events, me([])).length === 0)

const sql = readFileSync(new URL('../../../supabase/migrations/20261028020000_player_profiles.sql', import.meta.url), 'utf8')
const allowed = [...sql.match(/interests <@ array\[([^\]]+)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
check('interest ids match the migration’s check constraint', JSON.stringify(allowed) === JSON.stringify(INTERESTS.map((i) => i.id)), { allowed, ts: INTERESTS.map((i) => i.id) })
check('the constraint’s size cap fits every interest', new RegExp(`cardinality\\(interests\\) <= ${INTERESTS.length}`).test(sql))

console.log(failures ? `\n${failures} check(s) failed` : '\nAll interest-matching checks passed')
process.exit(failures ? 1 : 0)
