// End-to-end checks in headless Microsoft Edge at phone size, against the mock Supabase (tests/mock/supabase.mjs).
// Starts the mock, builds the app for production against it, and serves that build, so nothing else needs to run:
//
//   npm run test:e2e                      # uses installed Edge (Windows/macOS)
//   E2E_BROWSER_CHANNEL=chrome npm run test:e2e
//
// Why headless Edge: MapLibre renders only on requestAnimationFrame, which embedded/hidden browser panes often stop
// firing. Software WebGL (SwiftShader) is enough to render and query the map.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { MOCK_PORT, OLD_MAIN_LAWN, SERVICE_ROLE_KEY, startMockSupabase } from '../mock/supabase.mjs'

const WEB_DIR = fileURLToPath(new URL('../../', import.meta.url))
const PORT = Number(process.env.E2E_PORT ?? 5199)
const BASE = `http://localhost:${PORT}`
const MOCK = `http://localhost:${MOCK_PORT}`
const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url))
const M_PER_DEG_LAT = 111_195
mkdirSync(SHOTS, { recursive: true })

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(detail)}`)
  if (!ok) failures++
}

const OUT_DIR = 'node_modules/.cache/e2e-dist'
const VITE = ['node_modules/vite/bin/vite.js']
// Env vars override web/.env, so a developer's real Supabase/Auth0 settings never reach the test build.
const TEST_ENV = { ...process.env, VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_ANON_KEY: 'mock', VITE_AUTH0_DOMAIN: '', VITE_AUTH0_CLIENT_ID: '', VITE_E2E: '1' }

/** Tests run against a production build (what Vercel serves), so prod-only breakage like the MapLibre worker shows up. */
async function buildAndServe() {
  const build = spawn(process.execPath, [...VITE, 'build', '--outDir', OUT_DIR, '--emptyOutDir'], { cwd: WEB_DIR, env: TEST_ENV, stdio: 'ignore' })
  const code = await new Promise((resolve) => build.on('exit', resolve))
  if (code !== 0) throw new Error(`vite build failed (${code})`)

  const server = spawn(process.execPath, [...VITE, 'preview', '--outDir', OUT_DIR, '--port', String(PORT), '--strictPort'], { cwd: WEB_DIR, env: TEST_ENV, stdio: 'ignore' })
  let exited = null
  server.on('exit', (c) => (exited = c))
  const deadline = Date.now() + 30_000
  for (;;) {
    if (exited !== null) throw new Error(`vite preview exited with ${exited}`)
    if (Date.now() > deadline) {
      server.kill()
      throw new Error('vite preview did not start in 30 s')
    }
    try {
      if ((await fetch(BASE)).ok) return server
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function newPhone(browser, position) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    geolocation: { latitude: position.lat, longitude: position.lng },
    permissions: ['geolocation'],
  })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e.message))
  // Console only says "Failed to load resource"; record the URL from the response instead.
  page.on('console', (m) => m.type() === 'error' && !/WebSocket|realtime|Failed to load resource/i.test(m.text()) && page.errors.push(m.text()))
  page.on('response', (r) => r.status() >= 400 && page.errors.push(`${r.status()} ${r.request().method()} ${r.url()}`))
  await page.goto(BASE)
  await page.fill('form input.input', 'Rayhan')
  await page.click('text=Start playing')
  return page
}

const mapReady = (page) =>
  page.waitForFunction(() => window.__walkpsuMap?.isStyleLoaded() && window.__walkpsuMap.queryRenderedFeatures({ layers: ['buildings-base'] }).length > 0, null, { timeout: 30_000 })

async function tapFeature(page, layer, id) {
  const pt = await page.evaluate(([layer, id]) => {
    const map = window.__walkpsuMap
    const f = map.queryRenderedFeatures({ layers: [layer] }).find((x) => x.properties.id === id)
    if (!f) return null
    const box = map.getContainer().getBoundingClientRect()
    const p = map.project(f.geometry.coordinates)
    return { x: box.left + p.x, y: box.top + p.y }
  }, [layer, id])
  if (!pt) throw new Error(`no rendered ${layer} feature ${id}`)
  await page.touchscreen.tap(pt.x, pt.y)
}

async function mapScenario(browser) {
  console.log('\n# Map (player 20 m from the Old Main lawn drop)')
  const page = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat + 20 / M_PER_DEG_LAT, lng: OLD_MAIN_LAWN.lng })
  await mapReady(page)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: SHOTS + 'map.png' })

  const s = await page.evaluate(() => {
    const map = window.__walkpsuMap
    const q = (layers) => map.queryRenderedFeatures({ layers })
    return {
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      basemapBuilding: map.getLayoutProperty('building', 'visibility'),
      lawns: !!map.getLayer('lawns'),
      controls: [...document.querySelectorAll('.maplibregl-ctrl')].map((c) => c.className),
      active: [...new Set(q(['buildings-active']).map((f) => f.properties.num))],
      heights: q(['buildings-base']).map((f) => f.properties.height),
      inRange: q(['claim-circles-in']).length,
      fogBelowGlow: map.getStyle().layers.findIndex((l) => l.id === 'fog') < map.getStyle().layers.findIndex((l) => l.id === 'buildings-active-glow'),
      // Player sprites are DOM markers (they breathe, blink and hop), so count them in the DOM, not the map's layers.
      me: document.querySelectorAll('.sprite.is-me').length,
    }
  })
  check('opens on the player at zoom 17, pitch 45, bearing -17', Math.round(s.zoom) === 17 && s.pitch === 45 && Math.round(s.bearing) === -17, s)
  check('basemap buildings hidden, lawns layer added', s.basemapBuilding === 'none' && s.lawns, s)
  check('only the compact attribution control', s.controls.length === 1 && /attrib/.test(s.controls[0]) && !/compact-show/.test(s.controls[0]), s.controls)
  check('building hosting the HUB check-in is highlighted', JSON.stringify(s.active) === '["0005000"]', s.active)
  check('extrusions are 10-15 m', s.heights.length > 0 && Math.min(...s.heights) >= 10 && Math.max(...s.heights) <= 15, [Math.min(...s.heights), Math.max(...s.heights)])
  check('in-range claim circle and my sprite render', s.inRange > 0 && s.me === 1, s)
  check('fog of war sits below the building glow (and everything drawn above it)', s.fogBelowGlow, s)
  const discovered = (await (await fetch(`${MOCK}/__state`)).json()).discovered.map((d) => d.hex_id)
  check('standing at Old Main discovers its area', discovered.includes('0:0'), discovered)

  await tapFeature(page, 'drop-points', 'center-drop')
  await page.waitForSelector('.map-card button.primary:not([disabled])')
  await page.waitForTimeout(600) // let the sheet finish sliding up
  await page.screenshot({ path: SHOTS + 'card.png' })
  const card = await page.textContent('.map-card')
  check('event drop card shows its organization and time', /Penn State Outing Club/.test(card) && /Happening now · until/.test(card), card)
  check('and no points anywhere', !/pts|points/i.test(card), card)
  await page.click('.map-card button.primary:has-text("Check in")')
  await page.waitForSelector('[data-sonner-toast]:has-text("You’re checked in!")', { timeout: 10_000 })
  let state = await (await fetch(`${MOCK}/__state`)).json()
  check('checking in within range is recorded', state.claims.some((c) => c.drop_id === 'center-drop'), state.claims)
  check('and the drop stays open for everyone else', state.drops.find((d) => d.id === 'center-drop').status === 'active')
  await page.waitForTimeout(800)
  await tapFeature(page, 'drop-points', 'center-drop')
  await page.waitForSelector('.map-card button.primary:not([disabled])')
  await page.waitForTimeout(600)
  await page.click('.map-card button.primary:has-text("Check in")')
  await page.waitForSelector('[data-sonner-toast]:has-text("already checked in")', { timeout: 10_000 })
  state = await (await fetch(`${MOCK}/__state`)).json()
  check('a second check-in is refused', state.claims.filter((c) => c.drop_id === 'center-drop').length === 1, state.claims)
  // That refusal is a 400 on purpose.
  page.errors = page.errors.filter((e) => !/400 POST .*claim_drop/.test(e))
  await page.touchscreen.tap(40, 300)
  await page.waitForTimeout(300)

  const fps = await page.evaluate(async () => {
    const map = window.__walkpsuMap
    let frames = 0
    let running = true
    const tick = () => {
      frames++
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    map.easeTo({ bearing: map.getBearing() + 120, zoom: map.getZoom() - 1, duration: 3000 })
    await new Promise((r) => setTimeout(r, 3000))
    running = false
    return frames / 3
  })
  console.log(`INFO ${fps.toFixed(0)} fps during a 3 s camera move (software WebGL; a phone GPU differs)`)

  const bounds = await page.evaluate(() => {
    const map = window.__walkpsuMap
    const [[w, s], [e, n]] = map.getMaxBounds().toArray()
    map.jumpTo({ center: [-77.9609, 40.7045], zoom: 16 })
    const c = map.getCenter()
    map.jumpTo({ zoom: 5 })
    return { inside: c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n, zoom: map.getZoom() }
  })
  check('cannot pan to Ag Progress Days or zoom out past campus', bounds.inside && bounds.zoom > 11.5, bounds)
  await page.click('.map-recenter')
  await page.waitForTimeout(1300)
  check('recenter returns to the player at zoom 17', Math.round(await page.evaluate(() => window.__walkpsuMap.getZoom())) === 17)

  const tabs = await page.$$eval('.bottom-nav-tab', (els) => els.map((e) => e.textContent.trim()))
  check('no leaderboard tab; admins get Clubs', JSON.stringify(tabs) === '["Map","Clubs","Profile"]', tabs)

  await page.goto(`${BASE}/admin`)
  await mapReady(page)
  const oldMain = await page.evaluate(() => {
    const map = window.__walkpsuMap
    map.jumpTo({ center: [-77.862804, 40.796443], zoom: 17 })
    const box = map.getContainer().getBoundingClientRect()
    const p = map.project([-77.862804, 40.796443])
    return { x: box.left + p.x, y: box.top + p.y }
  })
  await page.waitForTimeout(800)
  await page.touchscreen.tap(oldMain.x, oldMain.y)
  await page.waitForTimeout(400)
  const admin = await page.evaluate(() => ({
    where: document.querySelector('main section > p.muted.footnote')?.textContent,
    title: document.querySelector('form input.input')?.value,
    target: window.__walkpsuMap.queryRenderedFeatures({ layers: ['admin-target'] }).length,
  }))
  check('admin tap-to-place resolves the building', admin.where === 'At Old Main' && admin.title === 'Old Main' && admin.target === 1, admin)
  const form = (await page.textContent('form')).replace(/\s+/g, ' ')
  check('the admin form has no game picker, type, or points', !(await page.$('.game-option, form select')) && !/Points|Mini-game|Photo hunt/.test(form), form)
  await page.click('form button.primary')
  await page.waitForFunction(() => document.querySelector('form input.input')?.value === '')
  const created = (await (await fetch(`${MOCK}/__state`)).json()).drops.find((d) => d.title === 'Old Main')
  check('admins drop check-ins', created?.type === 'checkin', created)
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

async function searchScenario(browser) {
  console.log('\n# AI event search (the mock stands in for /api/search-events and Gemini)')
  const page = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat, lng: OLD_MAIN_LAWN.lng })
  // vite preview doesn't run web/api, so route the app's request to the mock's fixed results.
  await page.route('**/api/search-events', async (route) => {
    const res = await fetch(`${MOCK}/__search-events`, { method: 'POST', headers: route.request().headers(), body: route.request().postData() })
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() })
  })
  await mapReady(page)
  await page.waitForTimeout(800)
  const sheetText = async () => (await page.textContent('.search-sheet')).replace(/\s+/g, ' ')

  await page.click('.search-pill')
  await page.waitForSelector('.search-sheet .example-chip')
  const chips = (await page.locator('.search-sheet .example-chip').allTextContents()).map((c) => c.trim())
  check(
    'search shows example prompts and category picks',
    chips.slice(0, 3).join('|') === 'free food|something for CS majors|music tonight' && ['Sports', 'Music', 'Food', 'Arts', 'Games'].every((c) => chips.some((chip) => chip.endsWith(c))),
    chips,
  )
  await page.click('.search-sheet .example-chip:has-text("free food")')
  await page.waitForSelector('.search-sheet .search-result')
  let text = await sheetText()
  check('results show title, organization, place, and Gemini’s reason', /Late Night Pancakes.*Library Programming.*Pattee Library.*free pancakes at Pattee/.test(text), text)
  check('an online event is listed with its location and no building', /Virtual Study Hall.*Online/.test(text), text)
  check('matching live drops come first, under "Live on the map"', /Live on the map\s*Lawn Picnic.*Check-in.*Campus events/.test(text), text)
  check('a campus event already listed as a live drop isn’t repeated', (text.match(/Lawn Picnic/g) ?? []).length === 1, text)
  const narrowed = await page.evaluate(() => ({
    pill: document.querySelector('.map-top [role="status"]').textContent,
    pins: window.__walkpsuMap.getSource('drops').serialize().data.features.map((f) => f.properties.id),
  }))
  check('the map narrows to the matching drops', /Showing 1 of \d+ · “free food”/.test(narrowed.pill) && JSON.stringify(narrowed.pins) === '["event-drop"]', narrowed)
  await page.screenshot({ path: SHOTS + 'search-results.png' })

  await page.click('.search-result:has-text("Late Night Pancakes")')
  await page.waitForSelector('.event-sheet h3', { timeout: 5000 })
  await page.waitForTimeout(1200) // the map's glide
  const view = await page.evaluate(() => {
    const map = window.__walkpsuMap
    return {
      card: document.querySelector('.event-sheet').textContent.replace(/\s+/g, ' '),
      glowing: [...new Set(map.queryRenderedFeatures({ layers: ['buildings-active'] }).map((f) => f.properties.num))],
      // The glide puts the building above the sheet, so measure from where it's drawn, not the map center.
      onScreen: (() => {
        const p = map.project([-77.866229, 40.797799])
        return p.x > 0 && p.x < 375 && p.y > 0 && p.y < 500
      })(),
    }
  })
  check('tapping a result opens its card', /Late Night Pancakes.*Library Programming.*Pattee Library.*free pancakes/.test(view.card), view.card)
  check('the map flies to the building and lights it up', view.onScreen && view.glowing.includes('0003000'), view)
  await page.screenshot({ path: SHOTS + 'search-event.png' })

  await page.click('.search-pill')
  await page.waitForSelector('.search-sheet .search-result')
  check('reopening keeps the last results', /Late Night Pancakes/.test(await sheetText()))
  await page.click('.search-result:has-text("Lawn Picnic")')
  await page.waitForSelector('.drop-sheet:not(.search-sheet):not(.event-sheet) h3:has-text("Lawn Picnic")', { timeout: 5000 })
  check('a result you can check in at opens the drop’s own card', /Check in/.test(await page.textContent('.drop-sheet:not(.search-sheet):not(.event-sheet)')))
  const glowAfter = await page.evaluate(() => [...new Set(window.__walkpsuMap.queryRenderedFeatures({ layers: ['buildings-active'] }).map((f) => f.properties.num))])
  check('the searched building stops glowing once its card closes', !glowAfter.includes('0003000'), glowAfter)

  await page.click('.search-pill')
  await page.waitForSelector('.search-sheet input')
  await page.fill('.search-sheet input', 'zzz')
  await page.press('.search-sheet input', 'Enter')
  await page.waitForSelector('.search-sheet :text("Nothing matched")')
  check('no matches says to try something broader', /Nothing matched — try something broader/.test(await sheetText()))
  await page.fill('.search-sheet input', 'busy please')
  await page.press('.search-sheet input', 'Enter')
  await page.waitForSelector('.search-sheet [role="alert"]')
  text = await sheetText()
  check('a busy Gemini shows a friendly error and a retry', /busy/.test(text) && /Try again/.test(text), text)

  // Gemini unavailable: the server's keyword search answers, and the sheet says so.
  await page.fill('.search-sheet input', 'offline free food')
  await page.press('.search-sheet input', 'Enter')
  await page.waitForSelector('.search-sheet .search-mode-note')
  check('keyword fallback results are labeled', /AI search is unavailable right now, so these are keyword matches/.test(await sheetText()))

  const mapState = () =>
    page.evaluate(() => ({
      pill: document.querySelector('.map-top [role="status"]').textContent,
      pins: window.__walkpsuMap.getSource('drops').serialize().data.features.length,
      clear: !!document.querySelector('.pill-clear'),
    }))
  const live = (await (await fetch(`${MOCK}/__state`)).json()).drops.filter((d) => d.status === 'active').length

  // A search with no matching drops ("zzz") leaves every drop on the map instead of emptying it.
  await page.fill('.search-sheet input', 'zzz')
  await page.press('.search-sheet input', 'Enter')
  await page.waitForSelector('.search-sheet :text("Nothing matched")')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  let map = await mapState()
  check('a search that matched no live drops leaves every drop on the map', /live drops?$/.test(map.pill) && map.pins === live && !map.clear, { map, live })

  // A narrowing search, then the ✕ in the status pill brings every drop back.
  await page.click('.search-pill')
  await page.waitForSelector('.search-sheet input')
  await page.fill('.search-sheet input', 'free food')
  await page.press('.search-sheet input', 'Enter')
  await page.waitForSelector('.search-sheet .search-result')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  check('the pill shows the narrowed map', /Showing 1 of/.test((await mapState()).pill))
  await page.click('.pill-clear')
  await page.waitForTimeout(300)
  map = await mapState()
  check('clearing the search shows every drop again', /live drops?$/.test(map.pill) && map.pins === live, { map, live })
  // The 503 from the stand-in is expected; anything else isn't.
  check('no console errors', page.errors.filter((e) => !/503 POST .*api\/search-events/.test(e)).length === 0, page.errors)
  await page.context().close()
}

async function campusEventsScenario(browser) {
  console.log('\n# Campus events on the map (synced Discover events, seeded through the mock’s sync_discover_events)')
  const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString()
  const at = (num, name, lat, lng) => ({ num, name, lat, lng, matched_by: 'location text' })
  const OSMOND = at('0401000', 'Osmond Laboratory (I Thornton)', 40.79846, -77.862438)
  const WILLARD = at('0012000', 'Willard (Joseph M)', 40.79568, -77.864627)
  const SACKETT = at('0301000', 'Sackett Building (Robert Lemuel)', 40.794587, -77.86241)
  const event = (id, title, starts, ends, building, location = building?.name ?? 'Zoom') => ({
    id, title, organization: 'E2E Club', theme: 'Social', categories: [], starts_at: hours(starts), ends_at: hours(ends), location, lat: null, lng: null, building,
  })
  const events = [
    event('e2e-osmond-1', 'Chemistry Club Social', 2, 4, OSMOND),
    event('e2e-osmond-2', 'Physics Study Night', 26, 28, OSMOND),
    event('e2e-willard', 'Debate Society', 5, 7, WILLARD),
    // Already a seeded drop (the mock's "Lawn Picnic"): it shows as that drop, not as an event pin.
    event('e2e-linked', 'Lawn Picnic', 1, 3, WILLARD),
    event('e2e-online', 'Virtual Hangout', 3, 4, null),
    event('e2e-later', 'Next Month Gala', 24 * 10, 24 * 10 + 3, SACKETT),
    // A month-long exhibit: never pinned or listed.
    event('e2e-exhibit', 'Long Exhibit', -24 * 10, 24 * 20, SACKETT),
  ]
  const res = await fetch(`${MOCK}/rest/v1/rpc/sync_discover_events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ p_events: events, p_complete: false }),
  })
  check('the mock accepts a sync', res.ok, res.status)
  // Two of the mock's bots are going to the Chemistry Club Social.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  for (const bot of ['bot0', 'bot1']) {
    await fetch(`${MOCK}/rest/v1/rpc/set_going`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b64({ alg: 'HS256' })}.${b64({ sub: bot, role: 'authenticated' })}.mock` },
      body: JSON.stringify({ p_event_id: 'e2e-osmond-1', p_going: true }),
    })
  }

  const page = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat, lng: OLD_MAIN_LAWN.lng })
  await mapReady(page)
  await page.waitForFunction(() => window.__walkpsuMap.getSource('events')?.serialize().data.features.length > 0, null, { timeout: 10_000 })
  const pins = await page.evaluate(() =>
    Object.fromEntries(window.__walkpsuMap.getSource('events').serialize().data.features.map((f) => [f.properties.num, f.properties.color])),
  )
  // Social, in EVENT_THEMES' color (src/lib/campus.ts).
  check('one pin per building, colored by its soonest event’s type', JSON.stringify(pins) === JSON.stringify({ '0401000': '#f59e0b', '0012000': '#f59e0b' }), pins)
  check('no pin for an online event, a seeded drop’s event, one over a week out, or a month-long exhibit', !pins['0301000'], pins)
  const tint = await page.evaluate(() => JSON.stringify(window.__walkpsuMap.getPaintProperty('buildings-base', 'fill-extrusion-color')))
  check('buildings with events are tinted', tint.includes('0401000') && tint.includes('0012000') && !tint.includes('0301000'), tint)

  // From further out, so the tap has to zoom in.
  await page.evaluate(() => window.__walkpsuMap.jumpTo({ center: [-77.8625, 40.7975], zoom: 15.5 }))
  await page.waitForTimeout(800)
  const pt = await page.evaluate(() => {
    const map = window.__walkpsuMap
    const f = map.queryRenderedFeatures({ layers: ['event-points'] }).find((x) => x.properties.num === '0401000')
    if (!f) return null
    const box = map.getContainer().getBoundingClientRect()
    const p = map.project(f.geometry.coordinates)
    return { x: box.left + p.x, y: box.top + p.y }
  })
  check('the Osmond pin is drawn', pt !== null)
  if (pt) await page.mouse.click(pt.x, pt.y)
  await page.waitForSelector('.event-sheet h3', { timeout: 5000 })
  await page.waitForTimeout(1200) // the glide
  const view = await page.evaluate(() => ({
    card: document.querySelector('.event-sheet').textContent.replace(/\s+/g, ' '),
    zoom: window.__walkpsuMap.getZoom(),
    onScreen: (() => {
      const p = window.__walkpsuMap.project([-77.862438, 40.79846])
      return p.x > 0 && p.x < 375 && p.y > 0 && p.y < 500
    })(),
  }))
  check('tapping a pin opens the soonest event there', /Chemistry Club Social.*E2E Club.*Osmond Laboratory/.test(view.card), view.card)
  check('and zooms in to the building', view.zoom >= 16.9 && view.onScreen, view)
  check('the card lists the building’s other events', /Also here.*Physics Study Night/.test(view.card), view.card)

  // RSVPs: a count (never names) and an I'm going toggle.
  const going = () => page.evaluate(() => ({ count: document.querySelector('.going-count')?.textContent, button: document.querySelector('.going-button')?.textContent }))
  await page.waitForFunction(() => /going/.test(document.querySelector('.going-count')?.textContent ?? '') && !document.querySelector('.going-button:disabled'))
  let g = await going()
  check('the card shows how many are going', g.count === '2 going' && g.button === 'I’m going', g)
  check('but never who', !/Bot (Ana|Ben)/.test(view.card), view.card)
  await page.click('.going-button')
  await page.waitForFunction(() => /Going ✓/.test(document.querySelector('.going-button')?.textContent ?? '') && !document.querySelector('.going-button:disabled'))
  g = await going()
  const rsvps = (await (await fetch(`${MOCK}/__state`)).json()).eventRsvps.filter((r) => r.event_id === 'e2e-osmond-1').length
  check('tapping I’m going counts me in', g.count === 'You and 2 others going' && rsvps === 3, { g, rsvps })
  await page.screenshot({ path: SHOTS + 'campus-events.png' })
  await page.click('.going-button')
  await page.waitForFunction(() => document.querySelector('.going-button')?.textContent === 'I’m going' && !document.querySelector('.going-button:disabled'))
  check('tapping again takes it back', (await going()).count === '2 going')
  await page.click('.event-sheet .search-result:has-text("Physics Study Night")')
  await page.waitForFunction(() => /Physics Study Night/.test(document.querySelector('.event-sheet h3')?.textContent ?? ''))
  check('tapping one shows it', /Also here.*Chemistry Club Social/.test((await page.textContent('.event-sheet')).replace(/\s+/g, ' ')))
  await page.waitForFunction(() => document.querySelector('.going-count')?.textContent === 'Be the first to go')
  check('with its own count', true)

  await page.click('.search-pill')
  await page.waitForSelector('.search-sheet .search-result')
  // A section of the search sheet by its heading: { titles, text }.
  const sheetSection = (heading) =>
    page.evaluate((heading) => {
      const s = [...document.querySelectorAll('.search-sheet section')].find((x) => x.querySelector('h4')?.textContent === heading)
      return s ? { titles: [...s.querySelectorAll('.search-result-title')].map((t) => t.textContent.trim()), text: s.textContent.replace(/\s+/g, ' ') } : null
    }, heading)
  const comingUp = await sheetSection('Coming up on campus')
  check(
    'the search sheet lists upcoming events, soonest first, without long exhibits',
    JSON.stringify(comingUp?.titles) === JSON.stringify(['Lawn Picnic', 'Chemistry Club Social', 'Virtual Hangout', 'Debate Society', 'Physics Study Night', 'Next Month Gala']),
    comingUp,
  )
  check('a listed event that is a drop says you can check in there', /Lawn Picnic.*Check in here/.test(comingUp?.text ?? ''))
  check('with no profile yet, it offers picks instead of a For you list', !!(await page.$('.search-sheet .for-you-nudge')) && (await sheetSection('For you')) === null)
  await page.screenshot({ path: SHOTS + 'coming-up.png' })

  // Profile, through the nudge: a major and interests, saved privately.
  await page.click('.search-sheet .for-you-nudge')
  await page.waitForSelector('.about-card .interest-chip')
  check('the nudge opens Profile', new URL(page.url()).pathname === '/profile')
  await page.fill('.about-card input', 'Chemistry')
  await page.click('.about-card .interest-chip:has-text("Social")')
  await page.click('.about-card .interest-chip:has-text("Sports")')
  const pressed = () => page.$$eval('.about-card .interest-chip[aria-pressed="true"]', (els) => els.map((e) => e.textContent.trim()))
  check('interest chips toggle on', JSON.stringify(await pressed()) === '["🏀 Sports","🎉 Social"]', await pressed())
  await page.click('.about-card .interest-chip:has-text("Sports")')
  check('and off', JSON.stringify(await pressed()) === '["🎉 Social"]', await pressed())
  await page.click('.about-card button.primary')
  await page.waitForFunction(() => document.querySelector('.about-card button.primary')?.textContent === 'Saved')
  const profiles = (await (await fetch(`${MOCK}/__state`)).json()).profiles
  check('the profile is saved', profiles.length === 1 && profiles[0].major === 'Chemistry' && JSON.stringify(profiles[0].interests) === '["social"]', profiles)
  await page.screenshot({ path: SHOTS + 'profile.png', fullPage: true })

  await page.click('.bottom-nav a[href="/"]')
  await mapReady(page)
  await page.click('.search-pill')
  await page.waitForSelector('.search-sheet .search-result')
  const picks = await sheetSection('For you')
  check('For you puts the best match first: Social plus the Chemistry major', picks?.titles[0] === 'Chemistry Club Social' && /Chemistry Club Social.*For you: Social, Chemistry/.test(picks.text), picks)
  check('at most 5 picks, each a match', picks?.titles.length === 5 && !picks.titles.includes('Long Exhibit'), picks)
  check('the nudge is gone', !(await page.$('.search-sheet .for-you-nudge')))
  await page.screenshot({ path: SHOTS + 'for-you.png' })
  await page.click('.search-sheet section:has(h4:text-is("For you")) .search-result:has-text("Chemistry Club Social")')
  await page.waitForSelector('.event-sheet .for-you-chip')
  check('the event card says why it’s for you', (await page.textContent('.event-sheet .for-you-chip')) === '★ For you · Social, Chemistry', await page.textContent('.event-sheet .for-you-chip'))

  await page.click('.map-info')
  await page.waitForSelector('.map-key-sheet .map-key-row')
  const key = await page.$$eval('.map-key-sheet .map-key-row', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()))
  check('the ⓘ opens a map key: every event type, the drops, and the building colors', key.length === 9 + 2 + 2 && /^Social/.test(key[0]) && key.some((r) => /^Meetup/.test(r)) && key.some((r) => /^Light blue/.test(r)), key)
  const cardClosed = await page
    .waitForFunction(() => !document.querySelector('.event-sheet[data-state="open"]'), null, { timeout: 3000 })
    .then(() => true, () => false)
  check('and closes the event card it would cover', cardClosed)
  await page.screenshot({ path: SHOTS + 'map-key.png' })
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

async function clubsScenario(browser) {
  console.log('\n# Clubs: event check-in, reminders, asking to run a club, approval, and the dashboard')
  const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString()
  const WILLARD = { num: '0012000', name: 'Willard (Joseph M)', lat: 40.79568, lng: -77.864627, matched_by: 'location text' }
  const club = (id, title, starts, ends) => ({
    id, title, organization: 'Chess Club', theme: 'Social', categories: [], benefits: [], starts_at: hours(starts), ends_at: hours(ends), location: WILLARD.name, lat: null, lng: null, building: WILLARD,
  })
  await fetch(`${MOCK}/rest/v1/rpc/sync_discover_events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    // Live now (started 15 minutes ago), a week ago, and in two days.
    body: JSON.stringify({ p_events: [club('chess-live', 'Chess Club Live', -0.25, 1.5), club('chess-past', 'Chess Night', -24 * 7, -24 * 7 + 2), club('chess-next', 'Chess Strategy', 48, 50)], p_complete: false }),
  })
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  await fetch(`${MOCK}/rest/v1/rpc/set_going`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b64({ alg: 'HS256' })}.${b64({ sub: 'bot0', role: 'authenticated' })}.mock` },
    body: JSON.stringify({ p_event_id: 'chess-next', p_going: true }),
  })
  // Two bots came last week. (No RPC checks anyone in to a past event, so straight into the mock's data.)
  for (const bot of ['bot0', 'bot1']) mock.db.eventCheckins.push({ event_id: 'chess-past', player_id: bot, created_at: hours(-24 * 7) })

  // 45 m south of Willard, where the live event is: in range, and my sprite doesn't cover the building's pin.
  const page = await newPhone(browser, { lat: WILLARD.lat - 45 / M_PER_DEG_LAT, lng: WILLARD.lng })
  await mapReady(page)
  const me = mock.db.players.at(-1)
  await page.waitForFunction(() => window.__walkpsuMap.queryRenderedFeatures({ layers: ['event-points'] }).some((f) => f.properties.num === '0012000'), null, { timeout: 10_000 })
  const pt = await page.evaluate(() => {
    const map = window.__walkpsuMap
    const f = map.queryRenderedFeatures({ layers: ['event-points'] }).find((x) => x.properties.num === '0012000')
    const box = map.getContainer().getBoundingClientRect()
    const p = map.project(f.geometry.coordinates)
    return { x: box.left + p.x, y: box.top + p.y }
  })
  await page.mouse.click(pt.x, pt.y)
  await page.waitForFunction(() => document.querySelector('.event-sheet h3')?.textContent === 'Chess Club Live', null, { timeout: 5000 })
  await page.waitForSelector('.event-sheet .check-in-button:not([disabled])', { timeout: 10_000 })
  check('a live event’s card offers check-in when you’re at its building', /You’re here/.test(await page.textContent('.event-sheet')))

  // RSVP, and the reminder shows top left.
  await page.waitForSelector('.going-button:not([disabled])')
  await page.click('.going-button')
  await page.waitForSelector('.reminder', { timeout: 5000 })
  const reminder = (await page.textContent('.reminder')).replace(/\s+/g, ' ')
  check('an event I’m going to that’s on now shows a reminder', /Happening now · You’re going/.test(reminder) && /Chess Club Live/.test(reminder) && /Willard/.test(reminder), reminder)
  const box = await page.$eval('.reminder', (el) => el.getBoundingClientRect().toJSON())
  check('top left of the map', box.left < 80 && box.top < 200, box)
  await page.screenshot({ path: SHOTS + 'reminder.png' })

  await page.click('.event-sheet .check-in-button')
  await page.waitForSelector('.event-sheet .checked-in', { timeout: 10_000 })
  check('checking in by GPS is recorded', mock.db.eventCheckins.some((c) => c.event_id === 'chess-live' && c.player_id === me.id))
  check('and its reminder goes away', await page.waitForSelector('.reminder', { state: 'detached', timeout: 5000 }).then(() => true, () => false))

  // Ask to run the club.
  await page.click('.event-sheet .club-ask')
  await page.fill('.club-ask-form input', 'President')
  await page.click('.club-ask-form button.primary')
  await page.waitForSelector('.event-sheet .club-pending', { timeout: 5000 })
  const request = mock.db.requests.find((r) => r.organization === 'Chess Club' && r.player_id === me.id)
  check('the request waits for an admin, with my role', request?.status === 'pending' && request.note === 'President', request)
  await page.screenshot({ path: SHOTS + 'event-checked-in.png' })

  // Everyone is an admin in the mock: approve it from /admin.
  await page.goto(`${BASE}/admin`)
  await page.waitForSelector('.organizer-request:has-text("Chess Club")', { timeout: 10_000 })
  check('admins see who asked and why', /Rayhan · “President”/.test(await page.textContent('.organizer-request:has-text("Chess Club")')))
  await page.click('.organizer-request:has-text("Chess Club") button.primary')
  await page.waitForSelector('main :text("No one is waiting.")', { timeout: 5000 })
  check('approving makes me an organizer', mock.db.organizers.some((o) => o.organization === 'Chess Club' && o.player_id === me.id))

  // I came last week too: of 3 people who came, 1 came back.
  mock.db.eventCheckins.push({ event_id: 'chess-past', player_id: me.id, created_at: hours(-24 * 7) })
  await page.route('**/api/club-insights', async (route) => {
    const res = await fetch(`${MOCK}/__club-insights`, { method: 'POST', headers: route.request().headers(), body: route.request().postData() })
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() })
  })
  await page.click('.bottom-nav a[href="/clubs"]')
  await page.waitForSelector('.club-link:has-text("Chess Club")')
  check('the Clubs tab lists the club I run', /You run this club/.test(await page.textContent('.club-link:has-text("Chess Club")')))
  await page.click('.club-link:has-text("Chess Club")')
  await page.waitForSelector('.retention-rate')
  await page.waitForSelector('.suggestion')
  const dash = await page.evaluate(() => ({
    rate: document.querySelector('.retention-rate').textContent,
    retention: document.querySelector('.retention-card').textContent.replace(/\s+/g, ' '),
    tiles: Object.fromEntries([...document.querySelectorAll('.stat-tile')].map((t) => [t.children[0].textContent, t.children[1].textContent])),
    suggestions: document.querySelectorAll('.suggestion').length,
    text: document.querySelector('.club-dashboard').textContent.replace(/\s+/g, ' '),
  }))
  check('the second-visit rate leads the dashboard', dash.rate === '33%' && /1 of 3 people who came came back/.test(dash.retention), dash)
  check('interested, RSVP’d, checked in, came back', JSON.stringify(dash.tiles) === JSON.stringify({ Interested: '4', 'RSVP’d': '2', 'Checked in': '4', 'Came back': '1' }), dash.tiles)
  check('next-event ideas, labeled when they come from the numbers alone', dash.suggestions === 2 && /AI is unavailable right now/.test(dash.text) && /Osmond Laboratory/.test(dash.text), dash.text)
  check('upcoming events with their counts', /Chess Club Live.*2 interested · 1 going · 1 checked in/.test(dash.text) && /Chess Strategy.*2 interested · 1 going/.test(dash.text), dash.text)
  check('past events with how many came', /Chess Night.*3 came/.test(dash.text), dash.text)
  check('counts only, never who', !/Rayhan|Bot Ana|Bot Ben/.test(dash.text), dash.text)
  await page.screenshot({ path: SHOTS + 'club-dashboard.png', fullPage: true })

  // The door QR code checks a second phone in from anywhere.
  await page.click('.qr-toggle:has-text("Chess Club Live")')
  await page.waitForSelector('.qr-code svg')
  const code = mock.db.eventSecrets.find((s) => s.event_id === 'chess-live')?.code
  check('an upcoming event shows its door QR code', !!code)
  const guest = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat, lng: OLD_MAIN_LAWN.lng })
  // Let the map finish loading first, so leaving the page doesn't abort its tile requests.
  await mapReady(guest)
  await guest.waitForTimeout(1500)
  await guest.goto(`${BASE}/checkin/chess-live?key=${code}`)
  await guest.waitForSelector('h1:has-text("checked in")', { timeout: 10_000 })
  check('scanning the door QR checks in from anywhere', (await guest.textContent('h1')) === 'You’re checked in!' && mock.db.eventCheckins.filter((c) => c.event_id === 'chess-live').length === 2)
  await guest.reload()
  await guest.waitForSelector('h1:has-text("checked in")', { timeout: 10_000 })
  check('scanning again says you’re already in', (await guest.textContent('h1')) === 'Already checked in')
  await guest.goto(`${BASE}/checkin/chess-live?key=wrong`)
  await guest.waitForSelector('h1:has-text("Couldn’t check in")', { timeout: 10_000 })
  check('a wrong code is refused', /doesn't match/.test(await guest.textContent('main')))
  check('no console errors', page.errors.length === 0 && guest.errors.filter((e) => !/400 POST .*check_in_event/.test(e)).length === 0, [...page.errors, ...guest.errors])
  await guest.context().close()
  await page.context().close()
}

async function meetupScenario(browser) {
  console.log('\n# Meetups and clearing drops (runs last: it clears the HUB check-in)')
  const page = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat - 40 / M_PER_DEG_LAT, lng: OLD_MAIN_LAWN.lng })
  await mapReady(page)
  await page.waitForTimeout(1000)
  await page.click('.meetup-fab')
  await page.waitForSelector('.meetup-sheet input')
  check('Pin button waits for text', await page.isDisabled('.meetup-sheet button.primary'))
  await page.fill('.meetup-sheet input', 'Volleyball on the lawn, come play!')
  await page.click('.meetup-sheet .segment:has-text("30 min")')
  await page.screenshot({ path: SHOTS + 'meetup-compose.png' })
  await page.click('.meetup-sheet button.primary')
  await page.waitForSelector('.drop-sheet:not(.meetup-sheet) .clear-drop', { timeout: 10_000 })
  const card = (await page.textContent('.drop-sheet:not(.meetup-sheet)')).replace(/\s+/g, ' ')
  check('the new meetup opens with who started it, its time, and no points', /Volleyball on the lawn/.test(card) && /Started by Rayhan/.test(card) && /Happening now/.test(card) && !/pts/.test(card), card)
  await page.screenshot({ path: SHOTS + 'meetup-card.png' })
  let state = await (await fetch(`${MOCK}/__state`)).json()
  const meetup = state.drops.find((d) => d.type === 'meetup' && d.status === 'active')
  check('stored as a 30-minute meetup', meetup && Math.round((Date.parse(meetup.expires_at) - Date.parse(meetup.created_at)) / 60_000) === 30, meetup)
  await page.waitForFunction((id) => window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === id), meetup.id, { timeout: 10_000 })
  check('it gets a pin but no claim circle', await page.evaluate(() => window.__walkpsuMap.getSource('claim-circles').serialize().data.features.length) === state.drops.filter((d) => d.status === 'active' && d.type !== 'meetup').length)

  await page.click('.clear-drop')
  check('ending asks for a second tap', /Tap again/.test(await page.textContent('.clear-drop')))
  await page.click('.clear-drop')
  await page.waitForFunction((id) => !window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === id), meetup.id, { timeout: 10_000 })
  state = await (await fetch(`${MOCK}/__state`)).json()
  check('my meetup ends and leaves the map', state.drops.find((d) => d.id === meetup.id).status === 'expired')

  // Everyone is an admin in the mock: clear the HUB check-in. Center it first, so the tap isn't
  // caught by the toast at the top of the screen.
  const hub = state.drops.find((d) => d.id === 'hub-drop')
  await page.evaluate(([lng, lat]) => window.__walkpsuMap.jumpTo({ center: [lng, lat] }), [hub.lng, hub.lat])
  await page.waitForTimeout(800)
  await tapFeature(page, 'drop-points', 'hub-drop')
  await page.waitForSelector('.drop-sheet .clear-drop')
  check('admins get "Clear from map" on any drop', /Clear from map/.test(await page.textContent('.drop-sheet .clear-drop')))
  await page.click('.drop-sheet .clear-drop')
  await page.click('.drop-sheet .clear-drop')
  await page.waitForFunction(() => !window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === 'hub-drop'), null, { timeout: 10_000 })
  state = await (await fetch(`${MOCK}/__state`)).json()
  check('a cleared drop is expired, not deleted', state.drops.find((d) => d.id === 'hub-drop').status === 'expired')
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

const mock = await startMockSupabase()
const server = await buildAndServe()
const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
try {
  await mapScenario(browser)
  await searchScenario(browser)
  await campusEventsScenario(browser)
  await clubsScenario(browser)
  await meetupScenario(browser)
} catch (e) {
  failures++
  console.log(`FAIL scenario crashed :: ${e.message}`)
} finally {
  await browser.close()
  server.kill()
  mock.close()
}
console.log(failures ? `\n${failures} check(s) failed (screenshots in tests/e2e/screenshots/)` : '\nAll e2e checks passed (screenshots in tests/e2e/screenshots/)')
process.exit(failures ? 1 : 0)
