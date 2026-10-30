import { createClient } from '@supabase/supabase-js'
import type { ClubStats, Database } from '../src/lib/database.types.ts'
import { CANDIDATE_HOURS, TIME_ZONE, WEEKDAYS, countInterested, localSlot, nextOccurrence, suggestSlots, type CampusEvent, type Suggestion } from './_clubInsights.ts'
import { readBuildings } from './_discover.ts'
import { GeminiError, HttpError, askGeminiJson, env, respond, signedInPlayer } from './_shared.ts'

// POST /api/club-insights { organization }: for a club's organizers (club_stats() checks), how many players are
// interested in its upcoming events, and when and where to hold the next one.
//
// "Interested" counts players who RSVP'd or whose profile matches (lib/interests.ts, as "For you" does on the phone).
// Profiles are private, so this reads them with the service key and returns only counts. Gemini gets counts, the club's
// own (public) event titles, times and buildings, never anything about a player. When Gemini can't answer, the
// suggestions come from the numbers alone (suggestSlots) and say so.

/** Mirrored by ClubInsights in src/lib/api.ts. */
export type ClubInsights = { interested: number; interestedByEvent: Record<string, number>; suggestions: Suggestion[]; mode: 'ai' | 'stats' }

const MAX_PROFILES = 5000
const DAY_MS = 86_400_000

let buildingNames: Map<string, string> | null = null
const nameOf = (num: string) => {
  buildingNames ??= new Map(readBuildings().map((b) => [b.properties.num, b.properties.name]))
  return buildingNames.get(num)
}

const when = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function POST(request: Request) {
  return respond(() => insights(request))
}

async function insights(request: Request): Promise<ClubInsights> {
  const { asPlayer } = await signedInPlayer(request, 'see club insights')
  const body = (await request.json().catch(() => null)) as { organization?: unknown } | null
  const organization = typeof body?.organization === 'string' ? body.organization.trim() : ''
  if (!organization) throw new HttpError(400, 'Which club?')

  // As the caller, so only the club's organizers (and admins) get past this.
  const { data: stats, error } = await asPlayer.rpc('club_stats', { p_organization: organization })
  if (error) throw new HttpError(403, error.message)
  const club = (stats as ClubStats).events

  const asServer = createClient<Database>(env('VITE_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
  const now = Date.now()
  const since = new Date(now - 60 * DAY_MS).toISOString()
  const until = new Date(now + 15 * DAY_MS).toISOString()
  const [upcoming, profiles, campus] = await Promise.all([
    asServer
      .from('discover_events')
      .select('id, title, organization, theme, categories, benefits')
      .eq('organization', organization)
      .eq('cancelled', false)
      .gt('ends_at', new Date(now).toISOString()),
    asServer.from('player_profiles').select('player_id, major, interests').limit(MAX_PROFILES),
    // Every campus event from 60 days ago to two weeks out: past ones for attendance, upcoming ones for competition.
    asServer.from('discover_events').select('id, organization, starts_at, ends_at, building').eq('cancelled', false).gt('starts_at', since).lt('starts_at', until).limit(2000),
  ])
  for (const r of [upcoming, profiles, campus]) if (r.error) throw new Error(r.error.message)
  const upcomingIds = upcoming.data!.map((e) => e.id)
  const pastIds = campus.data!.filter((e) => Date.parse(e.ends_at) <= now).map((e) => e.id)
  const [rsvps, checkins] = await Promise.all([
    upcomingIds.length ? asServer.from('event_rsvps').select('event_id, player_id').in('event_id', upcomingIds) : { data: [], error: null },
    pastIds.length ? asServer.from('event_checkins').select('event_id').in('event_id', pastIds).limit(20000) : { data: [], error: null },
  ])
  for (const r of [rsvps, checkins]) if (r.error) throw new Error(r.error.message)

  const interested = countInterested(upcoming.data!, profiles.data!, rsvps.data!)
  const checkedIn = new Map<string, number>()
  for (const c of checkins.data!) checkedIn.set(c.event_id, (checkedIn.get(c.event_id) ?? 0) + 1)
  const toCampus = (e: NonNullable<typeof campus.data>[number]): CampusEvent => ({ starts_at: e.starts_at, building_num: e.building?.num ?? null, checked_in: checkedIn.get(e.id) ?? 0 })
  const others = campus.data!.filter((e) => e.organization !== organization)
  const numbers = {
    club,
    campusPast: others.filter((e) => Date.parse(e.ends_at) <= now).map(toCampus),
    campusUpcoming: others.filter((e) => Date.parse(e.starts_at) > now).map(toCampus),
    buildingName: nameOf,
    now,
  }
  const fallback = suggestSlots(numbers)

  let suggestions = fallback
  let mode: ClubInsights['mode'] = 'stats'
  if (process.env.GEMINI_API_KEY) {
    try {
      const picked = await askGemini(organization, numbers, interested.total, fallback)
      if (picked.length) {
        suggestions = picked
        mode = 'ai'
      }
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e
    }
  }
  return { interested: interested.total, interestedByEvent: interested.byEvent, suggestions, mode }
}

type Numbers = Parameters<typeof suggestSlots>[0]
type GeminiPick = { weekday: string; hour: number; building_num: string; reason: string }

/** Gemini's three picks, checked: a real weekday and candidate hour in the next two weeks, and a real building. */
async function askGemini(organization: string, n: Numbers, interested: number, fallback: Suggestion[]): Promise<Suggestion[]> {
  const line = (e: { starts_at: string; building: { name: string } | null; going: number; checked_in: number; title: string }) =>
    `${when.format(Date.parse(e.starts_at))} | ${e.building?.name ?? 'no building'} | ${e.going} RSVP'd | ${e.checked_in} checked in | ${e.title.slice(0, 80)}`
  const slotCounts = (events: CampusEvent[], value: (e: CampusEvent) => number) => {
    const totals = new Map<string, number>()
    for (const e of events) {
      const { weekday, hour } = localSlot(Date.parse(e.starts_at))
      const key = `${WEEKDAYS[weekday]} ${hour}:00`
      totals.set(key, (totals.get(key) ?? 0) + value(e))
    }
    return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}: ${v}`).join(', ') || '(none)'
  }
  const past = n.club.filter((e) => Date.parse(e.ends_at) <= n.now)
  const upcoming = n.club.filter((e) => Date.parse(e.ends_at) > n.now)
  const places = new Map<string, string>()
  for (const e of n.club) if (e.building) places.set(e.building.num, n.buildingName(e.building.num) ?? e.building.name)
  for (const s of fallback) if (s.building) places.set(s.building.num, s.building.name)

  const prompt = `You help a Penn State student club, "${organization.slice(0, 120)}", pick when and where to hold its next event so more people come, and come back. Times are State College local time.

The club's past events (when | where | RSVPs | check-ins | title):
${past.map(line).join('\n') || '(none yet)'}

Its upcoming events:
${upcoming.map(line).join('\n') || '(none)'}

${interested} players on the app are interested in its upcoming events.
Campus-wide check-ins by time slot over the last 60 days: ${slotCounts(n.campusPast, (e) => e.checked_in)}
Other campus events already scheduled by time slot in the next two weeks: ${slotCounts(n.campusUpcoming, () => 1)}

Buildings you may suggest (num | name): ${[...places].map(([num, name]) => `${num} | ${name}`).join('; ') || '(none: leave building_num empty)'}

Suggest exactly 3 different weekdays. Use hours from ${CANDIDATE_HOURS.join(', ')} only. Favor slots where the club's events drew the most check-ins, campus attendance is high, and few other events compete. Each reason is one short sentence citing the numbers.`
  const schema = {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: { weekday: { type: 'string', enum: WEEKDAYS }, hour: { type: 'integer' }, building_num: { type: 'string' }, reason: { type: 'string' } },
          required: ['weekday', 'hour', 'building_num', 'reason'],
        },
      },
    },
    required: ['suggestions'],
  }
  const answer = await askGeminiJson<{ suggestions?: GeminiPick[] }>([{ text: prompt }], schema, 'The event planner')
  const busy = new Set(upcoming.map((e) => localSlot(Date.parse(e.starts_at)).date))
  const days = new Set<number>()
  const picks: Suggestion[] = []
  for (const s of answer.suggestions ?? []) {
    const weekday = WEEKDAYS.indexOf(s.weekday)
    if (weekday < 0 || days.has(weekday) || !CANDIDATE_HOURS.includes(s.hour)) continue
    const startsAt = nextOccurrence(weekday, s.hour, n.now, busy)
    if (!startsAt) continue
    days.add(weekday)
    const name = s.building_num ? places.get(s.building_num) : undefined
    const reason = typeof s.reason === 'string' ? s.reason.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    picks.push({ starts_at: startsAt, building: name ? { num: s.building_num, name } : null, reason })
    if (picks.length === 3) break
  }
  return picks
}
