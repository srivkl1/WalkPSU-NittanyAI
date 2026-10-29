import { useCallback, useEffect, useState } from 'react'
import {
  getClaimCodes,
  getClaimRadius,
  getDrops,
  getMyClubs,
  getMyEventActivity,
  getMyProfile,
  getUpcomingEvents,
  subscribeToDrops,
  subscribeToMyActivity,
  subscribeToProfile,
  type MyProfile,
  type UpcomingEvent,
} from './api'
import { loadBuildings, type Building } from './buildings'
import type { DropRow, OrganizerRequest } from './database.types'

type Subscribe = (onChange: () => void) => () => void

/** Re-runs `load` on mount and whenever `subscribe` reports a change. Call `refresh` after your own writes
 * so the screen updates even if the Realtime socket is down. */
function useLiveQuery<T>(load: () => Promise<T>, initial: T, subscribe: Subscribe = subscribeToDrops) {
  const [data, setData] = useState<T>(initial)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => load().then(setData, (e: Error) => setError(e.message)), [load])
  useEffect(() => {
    refresh()
    return subscribe(refresh)
  }, [refresh, subscribe])
  return { data, error, refresh }
}

const NO_DROPS: DropRow[] = []
const NO_CODES = new Map<string, string>()

export const useDrops = () => useLiveQuery(getDrops, NO_DROPS)
export const useClaimCodes = () => useLiveQuery(getClaimCodes, NO_CODES)

const NO_EVENTS: UpcomingEvent[] = []
// discover_events changes only when the sync runs (every 30 minutes), so a slow poll is enough; no Realtime.
const everyFewMinutes: Subscribe = (onChange) => {
  const timer = setInterval(onChange, 5 * 60_000)
  return () => clearInterval(timer)
}
/** Campus events this far ahead get a map pin. Search still reaches every upcoming event. */
const MAP_EVENT_WINDOW_MS = 7 * 24 * 3600_000
const loadMapEvents = async () => {
  const until = Date.now() + MAP_EVENT_WINDOW_MS
  return (await getUpcomingEvents(300)).filter((e) => Date.parse(e.starts_at) <= until)
}
const NO_PROFILE: MyProfile = { major: null, interests: [] }
// A missing table (migration not run) reads as an empty profile rather than an error on every screen.
const loadProfile = () => getMyProfile().catch(() => NO_PROFILE)
/** My major and interests; refreshes when I save them. */
export const useMyProfile = () => useLiveQuery(loadProfile, NO_PROFILE, subscribeToProfile)

const NO_ACTIVITY = { going: new Set<string>(), checkedIn: new Set<string>() }
// Missing tables (migrations not run) read as no activity rather than an error on every screen.
const loadActivity = () => getMyEventActivity().catch(() => NO_ACTIVITY)
/** The events I've RSVP'd to and checked in to; refreshes after I do either. */
export const useMyEventActivity = () => useLiveQuery(loadActivity, NO_ACTIVITY, subscribeToMyActivity)

const NO_CLUBS: { clubs: string[]; requests: OrganizerRequest[] } = { clubs: [], requests: [] }
const noSubscription: Subscribe = () => () => {}
/** The clubs I run and my requests to run others. Call refresh() after asking. */
export function useMyClubs(playerId: string) {
  const load = useCallback(() => getMyClubs(playerId).catch(() => NO_CLUBS), [playerId])
  return useLiveQuery(load, NO_CLUBS, noSubscription)
}

/** Campus events (Penn State Discover) starting within a week, soonest first, for the map. */
export const useUpcomingEvents = () => useLiveQuery(loadMapEvents, NO_EVENTS, everyFewMinutes)

let claimRadiusPromise: Promise<number> | null = null

/** Null until loaded from the server's claim_radius_m(). */
export function useClaimRadius() {
  const [radius, setRadius] = useState<number | null>(null)
  useEffect(() => {
    claimRadiusPromise ??= getClaimRadius()
    claimRadiusPromise.then(setRadius, (e: Error) => {
      claimRadiusPromise = null
      console.error(e)
    })
  }, [])
  return radius
}

export function useBuildings() {
  const [buildings, setBuildings] = useState<Building[]>([])
  useEffect(() => {
    loadBuildings().then(setBuildings, console.error)
  }, [])
  return buildings
}
