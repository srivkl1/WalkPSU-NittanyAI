// With the extension: api/_discover.ts imports this file, and api/ is typechecked with Node's module resolution.
import type { Building } from './buildings.ts'

const EARTH_RADIUS_M = 6371000
const rad = (deg: number) => (deg * Math.PI) / 180

/** Same haversine formula and earth radius as the SQL distance_m(), so client and server agree on "in range". */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// PASDA includes far-off PSU property (Ag Progress Days, the airport, research farms) that would stretch the
// campus box to ~20 km, so the box covers only buildings within this distance of the median building.
const CORE_RADIUS_M = 2500
const PADDING_M = 1600
const METERS_PER_DEG_LAT = 111_195

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]

/** [[west, south], [east, north]], the order MapLibre expects. */
export type Bounds = [[number, number], [number, number]]

export const insideBounds = ([[w, s], [e, n]]: Bounds, lat: number, lng: number) => lat >= s && lat <= n && lng >= w && lng <= e

/** University Park's building footprint padded by ~1 mile on every side. */
export function campusBounds(buildings: Building[]): Bounds {
  const center = { lat: median(buildings.map((b) => b.properties.lat)), lng: median(buildings.map((b) => b.properties.lng)) }
  const core = buildings.filter((b) => distanceM(center.lat, center.lng, b.properties.lat, b.properties.lng) <= CORE_RADIUS_M)
  const lats = core.map((b) => b.properties.lat)
  const lngs = core.map((b) => b.properties.lng)
  const padLat = PADDING_M / METERS_PER_DEG_LAT
  const padLng = PADDING_M / (METERS_PER_DEG_LAT * Math.cos(rad(center.lat)))
  return [
    [Math.min(...lngs) - padLng, Math.min(...lats) - padLat],
    [Math.max(...lngs) + padLng, Math.max(...lats) + padLat],
  ]
}
