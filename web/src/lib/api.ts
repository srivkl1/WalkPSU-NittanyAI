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

export type NewPhotoHunt = Pick<NewDrop, 'title' | 'lat' | 'lng' | 'points' | 'building_num' | 'expires_at'> & {
  hint_photo_url: string
  twist: string
}

/** Admin only. The server stores the exact spot privately and publishes only a search circle around it. */
export async function createPhotoHunt(hunt: NewPhotoHunt) {
  return unwrap(
    await supabase.rpc('create_photo_hunt', {
      p_title: hunt.title,
      p_lat: hunt.lat,
      p_lng: hunt.lng,
      p_hint_photo_url: hunt.hint_photo_url,
      p_twist: hunt.twist,
      p_points: hunt.points,
      p_building_num: hunt.building_num,
      p_expires_at: hunt.expires_at,
    }),
  )
}

/** Mirrors VerifyPhotoResponse in api/verify-photo.ts. */
export type PhotoVerdict = { match: true; points: number; reason: string } | { match: false; reason: string }

/** Sends a photo-hunt photo to /api/verify-photo, which checks GPS, asks Gemini, and records the claim on a match. */
export async function submitHuntPhoto(dropId: string, image: string, position: { lat: number; lng: number }) {
  const token = await getAccessToken()
  const response = await fetch('/api/verify-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ dropId, image, ...position }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `Photo check failed (${response.status})`)
  return body as PhotoVerdict
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
  return unwrap(await supabase.rpc('set_going', { p_event_id: eventId, p_going: going }))
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

/** Server checks the drop is active and unexpired, and that the player is within claim_radius_m() or has its QR code. */
export async function claimDrop(dropId: string, proof: ClaimProof) {
  return unwrap(await supabase.rpc('claim_drop', { p_drop_id: dropId, ...proofArgs(proof) }))
}

export async function getGameState(dropId: string) {
  return unwrap(await supabase.rpc('get_game_state', { p_drop_id: dropId }))
}

/** Same proof as claiming. Rejoining is a no-op; joining closes when the game starts. */
export async function joinGame(dropId: string, proof: ClaimProof) {
  unwrap(await supabase.rpc('join_game', { p_drop_id: dropId, ...proofArgs(proof) }))
}

/** Admin only. Starts the countdown (needs 2+ players). */
export async function startGame(dropId: string) {
  unwrap(await supabase.rpc('start_game', { p_drop_id: dropId }))
}

/** Reports a running shake total; the server caps it to a human rate and returns the stored value. */
export async function submitShakes(dropId: string, count: number) {
  return unwrap(await supabase.rpc('submit_shakes', { p_drop_id: dropId, p_count: count }))
}

/** Reports a running dodge total. The server caps it, and a hit freezes it. */
export async function submitDodges(dropId: string, count: number, eliminated = false) {
  return unwrap(await supabase.rpc('submit_dodges', { p_drop_id: dropId, p_count: count, p_eliminated: eliminated }))
}

/** Records a solo practice dodge count. Pays nothing and leaves the drop open. */
export async function submitGhost(dropId: string, count: number) {
  return unwrap(await supabase.rpc('submit_ghost', { p_drop_id: dropId, p_count: count }))
}

/** Quick Draw: a round's reaction time measured on this phone, or null for a flick before the signal. */
export async function submitReaction(dropId: string, round: number, reactionMs: number | null) {
  return unwrap(await supabase.rpc('submit_reaction', { p_drop_id: dropId, p_round: round, ...(reactionMs !== null && { p_reaction_ms: reactionMs }) }))
}

/** Point to the Landmark: a round's locked heading (degrees from true north). The server scores the error. */
export async function submitHeading(dropId: string, round: number, heading: number) {
  return unwrap(await supabase.rpc('submit_heading', { p_drop_id: dropId, p_round: round, p_heading: heading }))
}

/** Idempotent; any participant may call it once the submit grace period has passed. */
export async function finishGame(dropId: string) {
  return unwrap(await supabase.rpc('finish_game', { p_drop_id: dropId }))
}

/** Admin only (enforced by RLS). Maps drop id to its QR claim code. */
export async function getClaimCodes() {
  const rows = unwrap(await supabase.from('drop_secrets').select('*'))
  return new Map(rows.map((row) => [row.drop_id, row.claim_code]))
}

export function claimUrl(dropId: string, code: string) {
  return `${window.location.origin}/claim/${dropId}?key=${code}`
}

/** Any player: pins "volleyball here right now" at my position for `minutes` (15–180). No points. */
export async function createMeetup(meetup: { text: string; lat: number; lng: number; minutes: number; buildingNum: string | null }) {
  return unwrap(
    await supabase.rpc('create_meetup', { p_text: meetup.text, p_lat: meetup.lat, p_lng: meetup.lng, p_minutes: meetup.minutes, p_building_num: meetup.buildingNum }),
  )
}

/** Takes a drop off the map: admins any drop, players their own meetup. Points already earned stay. */
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

export async function getLeaderboard() {
  return unwrap(
    await supabase
      .from('player_scores')
      .select('*')
      .order('points', { ascending: false })
      .order('display_name'),
  )
}

/** The server's GPS claim radius in meters, so the map draws exactly what claim_drop enforces. */
export async function getClaimRadius() {
  return unwrap(await supabase.rpc('claim_radius_m'))
}

type RealtimeTable = 'drops' | 'claims' | 'games' | 'game_players' | 'game_results'
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

/** Claims flip a drop's status, so this also fires on every claim. */
export function subscribeToDrops(onChange: (drop: DropRow, event: 'INSERT' | 'UPDATE' | 'DELETE') => void) {
  return subscribeToTable('drops', onChange)
}
