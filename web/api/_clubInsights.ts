import { matchEvent, type MatchableEvent, type Profile } from '../src/lib/interests.ts'

// The numbers behind /api/club-insights, with no I/O so they can be tested directly. Everything here works on counts:
// the only per-player data is the profiles and RSVPs used to count who's interested, and none of it leaves this file.

export const TIME_ZONE = 'America/New_York'
/** Suggestions land at least this many days out (time to promote), and within two weeks. */
const MIN_DAYS_OUT = 2
const MAX_DAYS_OUT = 14
/** Times a student club would realistically meet, as local hours. */
export const CANDIDATE_HOURS = [12, 17, 18, 19, 20]
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** One of the club's events, as club_stats() returns it. */
export type ClubEventStat = {
  id: string
  title: string
  starts_at: string
  ends_at: string
  cancelled: boolean
  building: { num: string; name: string } | null
  going: number
  checked_in: number
}
/** An event anywhere on campus: when, where, and (for past ones) how many checked in. */
export type CampusEvent = { starts_at: string; building_num: string | null; checked_in: number }
export type Suggestion = { starts_at: string; building: { num: string; name: string } | null; reason: string }

/**
 * Distinct players interested in each upcoming event: those who RSVP'd, plus those whose profile (interests or major)
 * matches it, the same way "For you" does on the phone. `total` counts each player once across all the events.
 */
export function countInterested(
  events: (MatchableEvent & { id: string })[],
  profiles: (Profile & { player_id: string })[],
  rsvps: { event_id: string; player_id: string }[],
) {
  const all = new Set<string>()
  const byEvent: Record<string, number> = {}
  for (const event of events) {
    const people = new Set(rsvps.filter((r) => r.event_id === event.id).map((r) => r.player_id))
    for (const p of profiles) if (matchEvent(event, p).score > 0) people.add(p.player_id)
    byEvent[event.id] = people.size
    for (const id of people) all.add(id)
  }
  return { total: all.size, byEvent }
}

const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })

/** The local (State College) weekday (0 = Sunday), hour, and calendar date of an instant. */
export function localSlot(at: number) {
  const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]))
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    hour: Number(p.hour),
    date: `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`,
  }
}

/** The instant of a local wall-clock time, e.g. 7 PM in State College on a given date (handles daylight saving). */
function localTime(date: string, hour: number) {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  const seen = localSlot(guess)
  const [sy, sm, sd] = seen.date.split('-').map(Number)
  const drift = Date.UTC(sy, sm - 1, sd, seen.hour) - guess
  return guess - drift
}

/** The next `weekday` at `hour` (local) between MIN_DAYS_OUT and MAX_DAYS_OUT days from `now`, skipping busy dates. */
export function nextOccurrence(weekday: number, hour: number, now: number, skipDates: ReadonlySet<string> = new Set()) {
  for (let days = MIN_DAYS_OUT; days <= MAX_DAYS_OUT; days++) {
    const day = localSlot(now + days * 86_400_000)
    if (day.weekday !== weekday || skipDates.has(day.date)) continue
    return new Date(localTime(day.date, hour)).toISOString()
  }
  return null
}

const hourLabel = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

type SlotStats = { events: number; checkedIn: number; going: number }
const average = (s: SlotStats | undefined, key: 'checkedIn' | 'going') => (s && s.events > 0 ? s[key] / s.events : 0)

/** Per (weekday, hour) totals. The hour is bucketed to the nearest candidate hour so 6:30 counts as 6 PM. */
function bySlot<T>(items: T[], at: (item: T) => string, add: (stats: SlotStats, item: T) => void) {
  const slots = new Map<string, SlotStats>()
  for (const item of items) {
    const { weekday, hour } = localSlot(Date.parse(at(item)))
    const nearest = CANDIDATE_HOURS.reduce((best, h) => (Math.abs(h - hour) < Math.abs(best - hour) ? h : best))
    if (Math.abs(nearest - hour) > 1) continue
    const key = `${weekday}:${nearest}`
    const stats = slots.get(key) ?? { events: 0, checkedIn: 0, going: 0 }
    add(stats, item)
    slots.set(key, stats)
  }
  return slots
}

/**
 * Up to three times and places for the club's next event, from its own history (when its events drew the most check-ins
 * and RSVPs, and where), campus-wide attendance by time slot, and how many other events already sit in each slot over
 * the next two weeks. This is what the dashboard shows when Gemini can't answer, and what Gemini is given to work from.
 */
export function suggestSlots(input: {
  club: ClubEventStat[]
  campusPast: CampusEvent[]
  campusUpcoming: CampusEvent[]
  buildingName: (num: string) => string | undefined
  now: number
}): Suggestion[] {
  const { now } = input
  const past = input.club.filter((e) => !e.cancelled && Date.parse(e.ends_at) <= now)
  const mine = bySlot(past, (e) => e.starts_at, (s, e) => {
    s.events++
    s.checkedIn += e.checked_in
    s.going += e.going
  })
  const campus = bySlot(input.campusPast, (e) => e.starts_at, (s, e) => {
    s.events++
    s.checkedIn += e.checked_in
  })
  const competing = bySlot(input.campusUpcoming, (e) => e.starts_at, (s) => {
    s.events++
  })
  // Dates the club already has something on.
  const busy = new Set(input.club.filter((e) => !e.cancelled && Date.parse(e.ends_at) > now).map((e) => localSlot(Date.parse(e.starts_at)).date))

  const scored = WEEKDAYS.flatMap((_, weekday) =>
    CANDIDATE_HOURS.map((hour) => {
      const key = `${weekday}:${hour}`
      const own = mine.get(key)
      const crowd = competing.get(key)?.events ?? 0
      const midweekEvening = weekday >= 1 && weekday <= 4 && hour >= 18 && hour <= 19
      // Other events at the same time split the audience: four of them halve the expected turnout.
      const turnout = 3 * average(own, 'checkedIn') + average(own, 'going') + average(campus.get(key), 'checkedIn')
      const score = turnout / (1 + crowd / 4) + (midweekEvening ? 0.5 : 0)
      return { weekday, hour, key, own, crowd, campus: campus.get(key), score }
    }),
  ).sort((a, b) => b.score - a.score)

  // Where: the building where the club drew the most check-ins per event, else the one it uses most.
  const places = new Map<string, { name: string; events: number; checkedIn: number }>()
  for (const e of past) {
    if (!e.building) continue
    const p = places.get(e.building.num) ?? { name: e.building.name, events: 0, checkedIn: 0 }
    p.events++
    p.checkedIn += e.checked_in
    places.set(e.building.num, p)
  }
  for (const e of input.club) {
    if (e.building && !places.has(e.building.num)) places.set(e.building.num, { name: e.building.name, events: 0, checkedIn: 0 })
  }
  const [bestNum, best] = [...places].sort(([, a], [, b]) => b.checkedIn / (b.events || 1) - a.checkedIn / (a.events || 1) || b.events - a.events)[0] ?? []
  const building = bestNum ? { num: bestNum, name: input.buildingName(bestNum) ?? best!.name } : null

  const picks: Suggestion[] = []
  const usedDays = new Set<number>()
  for (const slot of scored) {
    if (picks.length === 3) break
    if (usedDays.has(slot.weekday)) continue
    const startsAt = nextOccurrence(slot.weekday, slot.hour, now, busy)
    if (!startsAt) continue
    usedDays.add(slot.weekday)
    const why: string[] = []
    if (slot.own && slot.own.events > 0) {
      why.push(`Your ${WEEKDAYS[slot.weekday]} ${hourLabel(slot.hour)} events averaged ${plural(Math.round(average(slot.own, 'checkedIn')), 'check-in')}`)
    } else if (slot.campus && slot.campus.events > 0) {
      why.push(`Campus events at this time averaged ${plural(Math.round(average(slot.campus, 'checkedIn')), 'check-in')}`)
    } else if (slot.weekday >= 1 && slot.weekday <= 4 && slot.hour >= 18 && slot.hour <= 19) {
      why.push('Weekday evenings fit most class schedules')
    }
    why.push(slot.crowd === 0 ? 'nothing else on campus is scheduled then' : `only ${plural(slot.crowd, 'other event')} on campus then`)
    if (building && places.get(building.num)!.events > 0) why.push(`${building.name} is where your events drew the most people`)
    const reason = why.join('; ')
    picks.push({ starts_at: startsAt, building, reason: reason.charAt(0).toUpperCase() + reason.slice(1) + '.' })
  }
  return picks
}
