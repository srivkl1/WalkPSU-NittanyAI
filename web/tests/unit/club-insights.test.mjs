// The club dashboard's numbers (api/_clubInsights.ts): who's interested (RSVPs plus profile matches, each player once),
// State College local time slots across daylight saving, and the no-AI suggestions for a club's next event.
import { countInterested, localSlot, nextOccurrence, suggestSlots } from '../../api/_clubInsights.ts'

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)}`)
  if (!ok) failures++
}

// --- Interested
const events = [
  { id: 'a', title: 'Chess Night', organization: 'Chess Club', theme: 'Social', categories: [], benefits: ['Free Food'] },
  { id: 'b', title: 'Chess Workshop', organization: 'Chess Club', theme: 'ThoughtfulLearning', categories: [], benefits: [] },
]
const profiles = [
  { player_id: 'food', major: null, interests: ['free_food'] },
  { player_id: 'social', major: null, interests: ['social'] },
  { player_id: 'none', major: null, interests: [] },
  { player_id: 'both', major: null, interests: ['social', 'academic'] },
]
const rsvps = [
  { event_id: 'a', player_id: 'food' }, // also a profile match: counted once
  { event_id: 'b', player_id: 'none' }, // no profile match, but RSVP'd
]
const interested = countInterested(events, profiles, rsvps)
check('an event counts RSVPs and profile matches, each player once', interested.byEvent.a === 3, interested)
check('an RSVP counts even without a matching profile', interested.byEvent.b === 2, interested)
check('the club total counts each player once across events', interested.total === 4, interested)
check('no events, nobody interested', countInterested([], profiles, rsvps).total === 0)

// --- Local time (America/New_York)
const summer = localSlot(Date.parse('2026-07-14T23:00:00Z')) // Tue 7 PM EDT
const winter = localSlot(Date.parse('2026-12-15T23:00:00Z')) // Tue 6 PM EST
check('local slot in daylight time', summer.weekday === 2 && summer.hour === 19 && summer.date === '2026-07-14', summer)
check('local slot in standard time', winter.weekday === 2 && winter.hour === 18 && winter.date === '2026-12-15', winter)
const sunday = Date.parse('2026-10-25T16:00:00Z')
const next = nextOccurrence(2, 19, sunday)
check('next Tuesday at 7 PM, at least 2 days out', next === '2026-10-27T23:00:00.000Z', next)
// Daylight saving ends Nov 1, so 7 PM is 00:00 UTC the next day from then on.
check('a busy date is skipped for the week after, in standard time', nextOccurrence(2, 19, sunday, new Set(['2026-10-27'])) === '2026-11-04T00:00:00.000Z', nextOccurrence(2, 19, sunday, new Set(['2026-10-27'])))
check('too soon rolls to next week', nextOccurrence(1, 19, sunday) === '2026-11-03T00:00:00.000Z', nextOccurrence(1, 19, sunday))

// --- Suggestions
const at = (iso) => iso
const osmond = { num: '0401000', name: 'Osmond Laboratory' }
const willard = { num: '0012000', name: 'Willard Building' }
const past = (id, startsAt, building, going, checkedIn) => ({ id, title: id, starts_at: at(startsAt), ends_at: new Date(Date.parse(startsAt) + 7200_000).toISOString(), cancelled: false, building, going, checked_in: checkedIn })
const club = [
  // Two Tuesday 7 PMs at Osmond drew 10 and 14; a Friday noon at Willard drew 2.
  past('t1', '2026-10-06T23:00:00Z', osmond, 12, 10),
  past('t2', '2026-10-13T23:00:00Z', osmond, 15, 14),
  past('f1', '2026-10-09T16:00:00Z', willard, 5, 2),
]
const picks = suggestSlots({ club, campusPast: [], campusUpcoming: [], buildingName: (num) => (num === osmond.num ? 'Osmond Laboratory (I Thornton)' : undefined), now: sunday })
check('three suggestions on different days', picks.length === 3 && new Set(picks.map((p) => localSlot(Date.parse(p.starts_at)).weekday)).size === 3, picks)
check('the best slot comes first: Tuesday 7 PM', picks[0]?.starts_at === '2026-10-27T23:00:00.000Z', picks[0])
check('at the building that drew the most per event, by its map name', picks[0]?.building?.num === osmond.num && picks[0].building.name === 'Osmond Laboratory (I Thornton)', picks[0])
check('the reason cites the club’s own numbers', /Tuesday 7 PM events averaged 12 check-ins/.test(picks[0]?.reason ?? ''), picks[0]?.reason)

// Twenty other events next Tuesday at 7 PM split the audience: a quieter slot wins.
const crowded = Array.from({ length: 20 }, () => ({ starts_at: '2026-10-27T23:00:00Z', building_num: null, checked_in: 0 }))
const avoid = suggestSlots({ club, campusPast: [], campusUpcoming: crowded, buildingName: () => undefined, now: sunday })
check('a slot packed with other events loses to quieter ones', localSlot(Date.parse(avoid[0].starts_at)).weekday !== 2 || localSlot(Date.parse(avoid[0].starts_at)).hour !== 19, avoid[0])

// A brand-new club with no history: campus attendance decides, and there's no building to suggest.
const campusPast = [{ starts_at: '2026-10-08T22:00:00Z', building_num: null, checked_in: 30 }] // a Thursday 6 PM
const fresh = suggestSlots({ club: [], campusPast, campusUpcoming: [], buildingName: () => undefined, now: sunday })
check('without history, the busiest campus slot leads', localSlot(Date.parse(fresh[0].starts_at)).weekday === 4 && localSlot(Date.parse(fresh[0].starts_at)).hour === 18, fresh[0])
check('and says why', /Campus events at this time averaged 30 check-ins/.test(fresh[0].reason) && fresh[0].building === null, fresh[0])
check('suggestions are always in the future, within two weeks', fresh.every((p) => Date.parse(p.starts_at) > sunday && Date.parse(p.starts_at) < sunday + 15 * 86_400_000), fresh)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll club-insights checks passed')
process.exit(failures ? 1 : 0)
