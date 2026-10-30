import type { PostgrestSingleResponse } from '@supabase/supabase-js'
import { getAccessToken, supabase } from './supabase'
import type { Database, DropRow, NewDrop, PlayerProfile, PlayerRow } from './database.types'

function unwrap<T>(response: PostgrestSingleResponse<T>): T {
  if (response.error) throw new Error(response.error.message)
  return response.data
}

export async function getPlayer(authId: string) {
  return unwrap(await supabase.from('players').select('*').eq('auth_id', authId).maybeSingle())
}

export async function createPlayer(displayName: string) {
  return unwrap(await supabase.from('players').insert({ display_name: displayName }).select().single())
}

export async function updatePlayer(id: string, changes: Partial<Pick<PlayerRow, 'display_name'>>) {
  return unwrap(await supabase.from('players').update(changes).eq('id', id).select().single())
}

/** Active drops that haven't expired. */
export async function getDrops() {
  const now = new Date().toISOString()
  return unwrap(
    await supabase
      .from('drops')
      .select('*')
      .eq('status', 'active')
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('created_at', { ascending: false }),
  )
}

/** Admin only (enforced by RLS). */
export async function createDrop(drop: NewDrop) {
  return unwrap(await supabase.from('drops').insert(drop).select().single())
}

/** Admin only. Returns the public URL to store as the drop's hint_photo_url. */
export async function uploadHintPhoto(file: File) {
  const path = `${crypto.randomUUID()}-${file.name}`
  const { error } = await supabase.storage.from('drop-hints').upload(path, file)
  if (error) throw new Error(error.message)
  return supabase.storage.from('drop-hints').getPublicUrl(path).data.publicUrl
}

/** A Penn State Discover event picked by /api/search-events. Mirrors EventResult in api/search-events.ts. */
export type EventResult = {
  id: string
  title: string
  organization: string | null
  theme: string | null
  starts_at: string
  ends_at: string
  location: string | null
  /** Null for online or vaguely located events: they get no map pin. */
  building: { num: string; name: string; lat: number; lng: number } | null
  /** Gemini's one-line "why this fits". */
  reason: string
}

// Discover also lists job postings and month-long exhibits; a browse list is for things you can go to soon.
const MAX_LISTED_EVENT_MS = 24 * 3600_000

/** An upcoming event with Discover's keywords, for "For you" matching (lib/interests.ts). */
export type UpcomingEvent = EventResult & { categories: string[]; benefits: string[] }

/** The next synced campus events (discover_events), soonest first, skipping cancelled and multi-day listings. */
export async function getUpcomingEvents(limit = 20): Promise<UpcomingEvent[]> {
  const rows = unwrap(
    await supabase
      .from('discover_events')
      // Every column, so a database without the newest one (benefits) still answers.
      .select('*')
      .eq('cancelled', false)
      .gt('ends_at', new Date().toISOString())
      .order('starts_at')
      // Long listings started long ago sort first, so read well past `limit` before filtering them out.
      .limit(500),
  )
  return rows
    .filter((e) => Date.parse(e.ends_at) - Date.parse(e.starts_at) <= MAX_LISTED_EVENT_MS)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      title: e.title,
      organization: e.organization,
      theme: e.theme,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      location: e.location,
      building: e.building && { num: e.building.num, name: e.building.name, lat: e.building.lat, lng: e.building.lng },
      reason: '',
      categories: e.categories ?? [],
      benefits: e.benefits ?? [],
    }))
}

export type MyProfile = Pick<PlayerProfile, 'major' | 'interests'>
const profileListeners = new Set<() => void>()

/** My major and interests (empty until saved). Private to me. */
export async function getMyProfile(): Promise<MyProfile> {
  const row = unwrap(await supabase.from('player_profiles').select('major, interests').maybeSingle())
  return row ?? { major: null, interests: [] }
}

export async function saveMyProfile(playerId: string, profile: MyProfile) {
  const major = profile.major?.trim() || null
  unwrap(await supabase.from('player_profiles').upsert({ player_id: playerId, major, interests: profile.interests }).select().single())
  for (const notify of profileListeners) notify()
}

/** Calls `onChange` after I save my profile (so "For you" updates at once). */
export function subscribeToProfile(onChange: () => void) {
  profileListeners.add(onChange)
  return () => {
    profileListeners.delete(onChange)
  }
}

export type Going = { going: number; me: boolean }

/** How many players are going to an event, and whether I am. */
export async function getGoing(eventId: string): Promise<Going> {
  const row = unwrap(await supabase.rpc('event_going', { p_event_ids: [eventId] }))[0]
  return row ? { going: row.going, me: row.me } : { going: 0, me: false }
}

/** RSVPs me on or off. Returns the event's new going count. */
export async function setGoing(eventId: string, going: boolean) {
  const count = unwrap(await supabase.rpc('set_going', { p_event_id: eventId, p_going: going }))
  for (const notify of activityListeners) notify()
  return count
}

const activityListeners = new Set<() => void>()

/** Calls `onChange` after I RSVP or check in (so reminders and cards update at once). */
export function subscribeToMyActivity(onChange: () => void) {
  activityListeners.add(onChange)
  return () => {
    activityListeners.delete(onChange)
  }
}

/** A live drop as search sees it: only what the map already shows, never its coordinates. */
export type SearchableDrop = { id: string; title: string; at?: string }
/** `mode` is "keyword" when Gemini couldn't answer and the server's keyword search did instead. */
export type SearchAnswer = { results: EventResult[]; dropIds: string[]; mode: 'ai' | 'keyword' }

// Same request over the same drops: reuse the answer instead of spending another Gemini call (and search quota).
const searchCache = new Map<string, SearchAnswer>()

/**
 * Natural-language search: campus events from the Discover snapshot, plus which live drops fit, in one Gemini call.
 * Throws a user-facing message (busy, rate limited, offline).
 */
export async function searchEvents(query: string, drops: SearchableDrop[]) {
  const key = `${query.trim().toLowerCase()}|${drops.map((d) => d.id).join(',')}`
  const cached = searchCache.get(key)
  if (cached) return cached
  const token = await getAccessToken()
  const response = await fetch('/api/search-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query, drops }),
  }).catch(() => null)
  if (!response) throw new Error('Couldn’t reach the event finder. Check your connection')
  const body = await response.json().catch(() => ({}))
  // No JSON error from our function means the platform gave up on it (a timeout or a crash).
  if (!response.ok) throw new Error(body.error ?? (response.status >= 500 ? 'The event finder took too long. Try again' : `Search failed (${response.status})`))
  const answer: SearchAnswer = { results: body.results ?? [], dropIds: body.dropIds ?? [], mode: body.mode === 'keyword' ? 'keyword' : 'ai' }
  // Keyword answers aren't kept, so the next try gets Gemini again once it's back.
  if (answer.mode === 'ai') searchCache.set(key, answer)
  return answer
}

export async function getDrop(id: string) {
  return unwrap(await supabase.from('drops').select('*').eq('id', id).maybeSingle())
}

export type ClaimProof = { lat: number; lng: number } | { code: string }

const proofArgs = (proof: ClaimProof) => ('code' in proof ? { p_code: proof.code } : { p_lat: proof.lat, p_lng: proof.lng })

/**
 * Checks me in at a drop: the server checks it's active and unexpired, and that I'm within claim_radius_m() or have
 * its QR code. Once per player; the drop stays open for everyone else.
 */
export async function claimDrop(dropId: string, proof: ClaimProof) {
  return unwrap(await supabase.rpc('claim_drop', { p_drop_id: dropId, ...proofArgs(proof) }))
}

/** Admin only (enforced by RLS). Maps drop id to its QR check-in code. */
export async function getClaimCodes() {
  const rows = unwrap(await supabase.from('drop_secrets').select('*'))
  return new Map(rows.map((row) => [row.drop_id, row.claim_code]))
}

export function claimUrl(dropId: string, code: string) {
  return `${window.location.origin}/claim/${dropId}?key=${code}`
}

/** Checks me in to a campus event: its door QR code, or GPS at its building. True the first time, false after. */
export async function checkInEvent(eventId: string, proof: ClaimProof) {
  const first = unwrap(await supabase.rpc('check_in_event', { p_event_id: eventId, ...proofArgs(proof) }))
  for (const notify of activityListeners) notify()
  return first
}

/** Ids of the events I've RSVP'd to and checked in to (RLS returns only my own rows). */
export async function getMyEventActivity() {
  const [rsvps, checkins] = await Promise.all([supabase.from('event_rsvps').select('event_id'), supabase.from('event_checkins').select('event_id')])
  return { going: new Set(unwrap(rsvps).map((r) => r.event_id)), checkedIn: new Set(unwrap(checkins).map((r) => r.event_id)) }
}

/** Organizers (and admins): an event's door QR code. */
export async function getEventCheckinCode(eventId: string) {
  return unwrap(await supabase.rpc('event_checkin_code', { p_event_id: eventId }))
}

export function eventCheckinUrl(eventId: string, code: string) {
  return `${window.location.origin}/checkin/${encodeURIComponent(eventId)}?key=${code}`
}

/** The clubs I run, and my requests to run others (RLS: my own rows only; admins see all). */
export async function getMyClubs(playerId: string) {
  const [organizers, requests] = await Promise.all([
    supabase.from('club_organizers').select('*').eq('player_id', playerId).order('organization'),
    supabase.from('organizer_requests').select('*').eq('player_id', playerId).order('created_at', { ascending: false }),
  ])
  return { clubs: unwrap(organizers).map((o) => o.organization), requests: unwrap(requests) }
}

/** Every club with an event coming up, A to Z (for admins, who can open any club's dashboard). */
export async function getClubNames() {
  const rows = unwrap(
    await supabase.from('discover_events').select('organization').eq('cancelled', false).gt('ends_at', new Date().toISOString()).limit(1000),
  )
  return [...new Set(rows.flatMap((r) => (r.organization ? [r.organization] : [])))].sort((a, b) => a.localeCompare(b))
}

/** "I run this club." Asking again while a request waits returns that request. */
export async function requestOrganizer(organization: string, note: string) {
  return unwrap(await supabase.rpc('request_organizer', { p_organization: organization, p_note: note }))
}

/** Admins: every waiting request, oldest first, with who asked. */
export async function getPendingOrganizerRequests() {
  const requests = unwrap(await supabase.from('organizer_requests').select('*').eq('status', 'pending').order('created_at'))
  if (requests.length === 0) return []
  const players = unwrap(await supabase.from('players').select('id, display_name').in('id', [...new Set(requests.map((r) => r.player_id))]))
  const names = new Map(players.map((p) => [p.id, p.display_name]))
  return requests.map((r) => ({ ...r, display_name: names.get(r.player_id) ?? 'A player' }))
}

/** Admins only. */
export async function decideOrganizerRequest(requestId: string, approve: boolean) {
  return unwrap(await supabase.rpc('decide_organizer_request', { p_request_id: requestId, p_approve: approve }))
}

/** Organizers (and admins): a club's numbers. Counts only. */
export async function getClubStats(organization: string) {
  return unwrap(await supabase.rpc('club_stats', { p_organization: organization }))
}

/** A suggested time and place for a club's next event. Mirrors Suggestion in api/club-insights.ts. */
export type ClubSuggestion = { starts_at: string; building: { num: string; name: string } | null; reason: string }
/** Mirrors ClubInsights in api/club-insights.ts. `mode` is "stats" when Gemini couldn't answer. */
export type ClubInsights = {
  /** Distinct players interested in the club's upcoming events: RSVP'd, or their interests or major match. */
  interested: number
  /** Per upcoming event id. */
  interestedByEvent: Record<string, number>
  suggestions: ClubSuggestion[]
  mode: 'ai' | 'stats'
}

/** /api/club-insights: who's interested (counts) and AI suggestions for the next event. */
export async function getClubInsights(organization: string): Promise<ClubInsights> {
  const token = await getAccessToken()
  const response = await fetch('/api/club-insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ organization }),
  }).catch(() => null)
  if (!response) throw new Error('Couldn’t reach the server. Check your connection')
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? 'Suggestions are unavailable right now')
  return body as ClubInsights
}

/** Any player: pins "volleyball here right now" at my position for `minutes` (15–180). */
export async function createMeetup(meetup: { text: string; lat: number; lng: number; minutes: number; buildingNum: string | null }) {
  return unwrap(
    await supabase.rpc('create_meetup', { p_text: meetup.text, p_lat: meetup.lat, p_lng: meetup.lng, p_minutes: meetup.minutes, p_building_num: meetup.buildingNum }),
  )
}

/** Takes a drop off the map: admins any drop, players their own meetup. Its check-ins stay. */
export async function closeDrop(dropId: string) {
  return unwrap(await supabase.rpc('close_drop', { p_drop_id: dropId }))
}

/** Hex ids of the areas I've discovered (RLS returns only my own rows). */
export async function getDiscoveredAreas() {
  return unwrap(await supabase.from('discovered_areas').select('hex_id')).map((row) => row.hex_id)
}

/** Records that I walked into an area. True if it was new; duplicates are ignored server-side. */
export async function discoverArea(hexId: string) {
  return unwrap(await supabase.rpc('discover_area', { p_hex_id: hexId }))
}

/** The server's GPS claim radius in meters, so the map draws exactly what claim_drop enforces. */
export async function getClaimRadius() {
  return unwrap(await supabase.rpc('claim_radius_m'))
}

type RealtimeTable = 'drops' | 'claims'
type RowOf<T extends RealtimeTable> = Database['public']['Tables'][T]['Row']

/** Calls onChange for every insert/update/delete on a Realtime-enabled table. Returns an unsubscribe fn. */
export function subscribeToTable<T extends RealtimeTable>(
  table: T,
  onChange: (row: RowOf<T>, event: 'INSERT' | 'UPDATE' | 'DELETE') => void,
  filter?: string,
) {
  const channel = supabase
    .channel(`${table}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table, filter }, (payload) => {
      onChange((payload.eventType === 'DELETE' ? payload.old : payload.new) as RowOf<T>, payload.eventType)
    })
    .subscribe()
  return () => {
    supabase.removeChannel(channel)
  }
}

export function subscribeToDrops(onChange: (drop: DropRow, event: 'INSERT' | 'UPDATE' | 'DELETE') => void) {
  return subscribeToTable('drops', onChange)
}
