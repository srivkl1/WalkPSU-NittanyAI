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
import { HUNT_SPOT, MOCK_PORT, NEEDLE_SPOT, OLD_MAIN_LAWN, SERVICE_ROLE_KEY, startMockSupabase } from '../mock/supabase.mjs'

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
  check('building hosting the Shake-Off drop is highlighted', JSON.stringify(s.active) === '["0005000"]', s.active)
  check('extrusions are 10-15 m', s.heights.length > 0 && Math.min(...s.heights) >= 10 && Math.max(...s.heights) <= 15, [Math.min(...s.heights), Math.max(...s.heights)])
  check('in-range claim circle and my sprite render', s.inRange > 0 && s.me === 1, s)
  check('fog of war sits below the building glow (and everything drawn above it)', s.fogBelowGlow, s)
  const discovered = (await (await fetch(`${MOCK}/__state`)).json()).discovered.map((d) => d.hex_id)
  check('standing at Old Main discovers its area', discovered.includes('0:0'), discovered)

  await tapFeature(page, 'drop-points', 'game-drop')
  await page.waitForSelector('.map-card')
  check('Shake-Off drop card offers the lobby', /Open the lobby/.test(await page.textContent('.map-card')))
  check('the card names the game', /Shake-Off/.test(await page.textContent('.map-card .game-kind')))
  await page.touchscreen.tap(40, 300)
  await page.waitForTimeout(300)

  await tapFeature(page, 'drop-points', 'center-drop')
  await page.waitForSelector('.map-card button.primary:not([disabled])')
  await page.waitForTimeout(600) // let the sheet finish sliding up
  await page.screenshot({ path: SHOTS + 'card.png' })
  const card = await page.textContent('.map-card')
  check('event drop card shows its organization and time', /Penn State Outing Club/.test(card) && /Happening now · until/.test(card), card)
  await page.click('.map-card button.primary')
  await page.waitForFunction(() => /Claimed!/.test(document.querySelector('.map-card')?.textContent ?? '') || !document.querySelector('.map-card'))
  await page.waitForFunction(() => !window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === 'center-drop'), null, { timeout: 10_000 })
  const state = await (await fetch(`${MOCK}/__state`)).json()
  check('Claim in range succeeds and the drop leaves the map', state.claims.some((c) => c.drop_id === 'center-drop'), state.claims)

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

  await page.click('a[href="/leaderboard"]')
  await page.waitForSelector('.leaderboard-row')
  check('leaderboard credits the claim', /Rayhan \(you\)\s*15/.test((await page.textContent('.leaderboard')).replace(/\s+/g, ' ')), await page.textContent('.leaderboard'))

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
    where: document.querySelector('main section > p.muted')?.textContent,
    title: document.querySelector('form input.input')?.value,
    target: window.__walkpsuMap.queryRenderedFeatures({ layers: ['admin-target'] }).length,
  }))
  check('admin tap-to-place resolves the building', admin.where === 'At Old Main' && admin.title === 'Old Main' && admin.target === 1, admin)
  const options = (await page.$$eval('.game-option', (els) => els.map((el) => el.textContent))).join(' | ')
  check('a minigame drop offers a game picker with descriptions', /Shake-Off.*shake.*\|.*Quick Draw.*DRAW!/.test(options) && /Needle Rain/.test(options) && /Point to the Landmark/.test(options), options)
  await page.check('.game-option input[value="quick_draw"]')
  await page.click('form button.primary')
  await page.waitForFunction(() => document.querySelector('form input.input')?.value === '')
  const created = (await (await fetch(`${MOCK}/__state`)).json()).drops.find((d) => d.title === 'Old Main')
  check('the drop stores the chosen game', created?.type === 'minigame' && created.game === 'quick_draw', created)
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

// 1x1 PNG: any real image will do, since the mock referee accepts every photo.
const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

async function photoHuntScenario(browser) {
  console.log('\n# Photo hunt (player 50 m from the hidden spot, inside the 60 m claim radius)')
  // Not exactly on the spot: the player's sprite would sit on top of the revealed pin and swallow the tap.
  const page = await newPhone(browser, { lat: HUNT_SPOT.lat, lng: HUNT_SPOT.lng + 50 / (M_PER_DEG_LAT * Math.cos((HUNT_SPOT.lat * Math.PI) / 180)) })
  // vite preview doesn't run web/api, and the real referee is Gemini, so the mock stands in for /api/verify-photo.
  await page.route('**/api/verify-photo', async (route) => {
    const res = await fetch(`${MOCK}/__verify-photo`, { method: 'POST', headers: route.request().headers(), body: route.request().postData() })
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() })
  })
  await mapReady(page)
  await page.waitForTimeout(1500)

  const rendered = () =>
    page.evaluate(() => {
      const q = (layers) => window.__walkpsuMap.queryRenderedFeatures({ layers }).map((f) => f.properties.id)
      return { areas: q(['hunt-areas']), pins: q(['drop-points']) }
    })
  let s = await rendered()
  check('hidden hunt shows a search circle and no pin', s.areas.includes('hunt-drop') && !s.pins.includes('hunt-drop'), s)

  const hunt = (await (await fetch(`${MOCK}/__state`)).json()).drops.find((d) => d.id === 'hunt-drop')
  const center = await page.evaluate(([lng, lat]) => {
    const map = window.__walkpsuMap
    const box = map.getContainer().getBoundingClientRect()
    const p = map.project([lng, lat])
    return { x: box.left + p.x, y: box.top + p.y }
  }, [hunt.lng, hunt.lat])
  await page.touchscreen.tap(center.x, center.y)
  await page.waitForSelector('.map-card .hunt-twist')
  await page.waitForSelector('.map-card label.button:not([aria-disabled])')
  check('card shows the twist and a camera button', /with a thumbs up/.test(await page.textContent('.map-card')) && /Take the photo/.test(await page.textContent('.map-card')))
  await page.screenshot({ path: SHOTS + 'photo-hunt-card.png' })

  await page.setInputFiles('.map-card input[type=file]', { name: 'spot.png', mimeType: 'image/png', buffer: PHOTO })
  await page.waitForSelector('.found-overlay', { timeout: 10_000 })
  const overlay = (await page.textContent('.found-overlay')).replace(/\s+/g, ' ')
  check('celebration shows the points and that the pin is revealed', /Found it!.*\+20 points.*First to find it/.test(overlay), overlay)
  await page.screenshot({ path: SHOTS + 'photo-hunt-celebration.png' })
  await page.click('.found-overlay .button')
  await page.waitForFunction(() => window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === 'hunt-drop'), null, { timeout: 10_000 })
  s = await rendered()
  check('after the first find, the red pin replaces the search circle', s.pins.includes('hunt-drop') && !s.areas.includes('hunt-drop'), s)
  const state = await (await fetch(`${MOCK}/__state`)).json()
  check('the claim earned the full 20 points', state.claims.some((c) => c.drop_id === 'hunt-drop' && c.points === 20), state.claims)
  await page.screenshot({ path: SHOTS + 'photo-hunt-found.png' })

  await tapFeature(page, 'drop-points', 'hunt-drop')
  await page.waitForFunction(() => /Closes in [67]:\d\d/.test(document.querySelector('.map-card')?.textContent ?? ''), null, { timeout: 5_000 })
  check('revealed card counts down the 7-minute window', true)
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
  check('matching live drops come first, under "Live on the map"', /Live on the map\s*Lawn Picnic.*Check-in · 15 pts.*Campus events/.test(text), text)
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
  check('a claimable result opens the drop’s own card', /Claim/.test(await page.textContent('.drop-sheet:not(.search-sheet):not(.event-sheet)')))
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
  const live = (await (await fetch(`${MOCK}/__state`)).json()).drops.filter((d) => d.status === 'active' && !(d.type === 'photo_hunt' && !d.first_found_at)).length

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
  check('a listed event that is a drop says it’s claimable', /Lawn Picnic.*Claimable · 15 pts/.test(comingUp?.text ?? ''))
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
  check('the ⓘ opens a map key: every event type, the drops, and the building colors', key.length === 9 + 5 + 2 && /^Social/.test(key[0]) && key.some((r) => /^Meetup/.test(r)) && key.some((r) => /^Light blue/.test(r)), key)
  const cardClosed = await page
    .waitForFunction(() => !document.querySelector('.event-sheet[data-state="open"]'), null, { timeout: 3000 })
    .then(() => true, () => false)
  check('and closes the event card it would cover', cardClosed)
  await page.screenshot({ path: SHOTS + 'map-key.png' })
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

async function meetupScenario(browser) {
  console.log('\n# Meetups and clearing drops (runs last: it clears the revealed photo hunt)')
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
  check('it gets a pin but no claim circle', await page.evaluate(() => window.__walkpsuMap.getSource('claim-circles').serialize().data.features.length) === state.drops.filter((d) => d.status === 'active' && !['meetup'].includes(d.type) && !(d.type === 'photo_hunt' && !d.first_found_at)).length)

  await page.click('.clear-drop')
  check('ending asks for a second tap', /Tap again/.test(await page.textContent('.clear-drop')))
  await page.click('.clear-drop')
  await page.waitForFunction((id) => !window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === id), meetup.id, { timeout: 10_000 })
  state = await (await fetch(`${MOCK}/__state`)).json()
  check('my meetup ends and leaves the map', state.drops.find((d) => d.id === meetup.id).status === 'expired')

  // Everyone is an admin in the mock: clear the photo hunt revealed earlier. Center it first, so the tap isn't
  // caught by the toast at the top of the screen.
  const hunt = state.drops.find((d) => d.id === 'hunt-drop')
  await page.evaluate(([lng, lat]) => window.__walkpsuMap.jumpTo({ center: [lng, lat] }), [hunt.lng, hunt.lat])
  await page.waitForTimeout(800)
  await tapFeature(page, 'drop-points', 'hunt-drop')
  await page.waitForSelector('.drop-sheet .clear-drop')
  check('admins get "Clear from map" on any drop', /Clear from map/.test(await page.textContent('.drop-sheet .clear-drop')))
  await page.click('.drop-sheet .clear-drop')
  await page.click('.drop-sheet .clear-drop')
  await page.waitForFunction(() => !window.__walkpsuMap.queryRenderedFeatures({ layers: ['drop-points'] }).some((f) => f.properties.id === 'hunt-drop'), null, { timeout: 10_000 })
  state = await (await fetch(`${MOCK}/__state`)).json()
  check('a cleared drop is expired, and the points it gave stay', state.drops.find((d) => d.id === 'hunt-drop').status === 'expired' && state.claims.some((c) => c.drop_id === 'hunt-drop'))
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

async function shakeOffScenario(browser) {
  console.log('\n# Shake-Off (3 bot players already in the lobby; joining makes 4)')
  const page = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat, lng: OLD_MAIN_LAWN.lng })
  await page.waitForSelector('.bottom-nav')
  // Behave like Android Chrome: no permission prompt, a live sensor stream.
  await page.evaluate(() => Object.defineProperty(DeviceMotionEvent, 'requestPermission', { value: undefined, configurable: true }))
  await page.evaluate(() => {
    window.history.pushState({}, '', '/game/game-drop')
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.__motion = (x) => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x, y: 0, z: 0 }, accelerationIncludingGravity: { x, y: 9.81, z: 0 }, interval: 16 }))
    window.__idle = setInterval(() => window.__motion(0.3), 100)
  })
  await page.click('text=Join the Shake-Off')
  await page.waitForSelector('.lobby-sides', { timeout: 10_000 })
  check('countdown lobby shows both sides with my name marked', /Rayhan \(you\)/.test(await page.textContent('.lobby-sides')))
  await page.waitForSelector('text=SHAKE!', { timeout: 15_000 })
  const shaken = await page.evaluate(async () => {
    let i = 0
    while (document.body.innerText.includes('SHAKE!')) {
      window.__motion(i++ % 2 ? 22 : -22)
      await new Promise((r) => setTimeout(r, 170))
    }
    clearInterval(window.__idle)
    return i
  })
  await page.waitForSelector('.game-winners', { timeout: 15_000 })
  await page.screenshot({ path: SHOTS + 'shake-off-result.png' })
  const result = (await page.textContent('.game-screen')).replace(/\s+/g, ' ')
  const state = await (await fetch(`${MOCK}/__state`)).json()
  const mine = state.gamePlayers.find((gp) => !gp.player_id.startsWith('bot'))
  check(`shakes counted and stored under the cap (${mine?.shakes} of ${shaken} jolts, cap 120)`, mine?.shakes > 40 && mine.shakes <= 120, mine)
  check('winner screen names the winners and points', /Rayhan & Bot \w+ win!\s*\+30 points each/.test(result), result)
  check('MVP called out', /MVP: Rayhan \(you\)/.test(result), result)
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

async function quickDrawScenario(browser) {
  console.log('\n# Quick Draw (3 bots in the lobby; joining makes 4; 3 rounds)')
  const page = await newPhone(browser, { lat: OLD_MAIN_LAWN.lat - 30 / M_PER_DEG_LAT, lng: OLD_MAIN_LAWN.lng })
  await page.waitForSelector('.bottom-nav')
  // A full page load, not in-app navigation: unmounting a loaded map races WalkLayers' fog layers (console errors).
  await page.addInitScript(() => Object.defineProperty(DeviceMotionEvent, 'requestPermission', { value: undefined, configurable: true }))
  await page.goto(`${BASE}/game/draw-drop`)
  page.errors = [] // leaving the map page cancels its tile requests; only the game page's errors count
  await page.evaluate(() => {
    // Holding still: a little hand tremor in both acceleration and rotation, which must never count as a flick.
    window.__motion = (x, spin = 0) =>
      window.dispatchEvent(
        new DeviceMotionEvent('devicemotion', { acceleration: { x, y: 0, z: 0 }, accelerationIncludingGravity: { x, y: 9.81, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: spin }, interval: 16 }),
      )
    window.__idle = setInterval(() => window.__motion(0.4, 12), 100)
  })
  await page.waitForSelector('.game-kind')
  check('lobby names the game', /Quick Draw/.test(await page.textContent('.game-kind')))
  // The big screen loads first: booting a second app (and its software-rendered map) mid-round would slow the phone.
  const projector = await newPhone(browser, OLD_MAIN_LAWN)
  // Let the map finish loading first: leaving it mid-load races its fog layers into console errors.
  await projector.waitForSelector('.bottom-nav')
  await projector.goto(`${BASE}/battle/draw-drop`)
  projector.errors = []
  await projector.waitForSelector('.battle-title')
  await page.click('text=Join the Quick Draw')
  await page.waitForSelector('.lobby-sides', { timeout: 10_000 })

  const outcomes = []
  for (const round of [1, 2, 3]) {
    await page.waitForSelector(`text=Round ${round} of 3`, { timeout: 15_000 })
    await page.waitForSelector('.draw-screen[data-stage="hold"]', { timeout: 5_000 })
    if (round === 1) await page.screenshot({ path: SHOTS + 'quick-draw-hold.png' })
    if (round === 2) {
      // Jump the gun: a small flick while it still says "Hold still…".
      await page.evaluate(() => window.__motion(4))
    } else {
      await page.waitForSelector('.draw-signal', { timeout: 5_000 })
      if (round === 1) await page.screenshot({ path: SHOTS + 'quick-draw-draw.png' })
      await page.waitForTimeout(150)
      // Gentle flicks must register: round 1 a light jolt (3.5 m/s²), round 3 a pure wrist twist (gyroscope only).
      await page.evaluate((round) => (round === 1 ? window.__motion(3.5) : window.__motion(0, 140)), round)
    }
    await page.waitForSelector('.draw-screen[data-stage="done"]', { timeout: 5_000 })
    outcomes.push((await page.textContent('.game-hero')).replace(/\s+/g, ' ').trim())
    if (round === 1) {
      await page.screenshot({ path: SHOTS + 'quick-draw-time.png' })
      await projector.waitForFunction(() => /Rayhan\s*White\s*\d+ ms/.test(document.querySelector('.round-ranking')?.textContent ?? ''), null, { timeout: 5_000 })
      await projector.screenshot({ path: SHOTS + 'quick-draw-projector.png' })
      check('projector ranks this round live', true)
    }
  }
  const [first, second, third] = outcomes
  check(`a flick after DRAW! shows the time (${first}, ${third})`, /^\d+\s*ms$/.test(first) && /^\d+\s*ms$/.test(third), outcomes)
  check('a flick before DRAW! is a false start', /False start!/.test(second), second)
  const state = await (await fetch(`${MOCK}/__state`)).json()
  const mine = state.results.filter((r) => r.drop_id === 'draw-drop' && !r.player_id.startsWith('bot')).sort((a, b) => a.round - b.round)
  check('server stored 2 times and 1 false start', mine.length === 3 && mine[1].false_start && mine[0].value >= 100 && mine[2].value >= 100, mine)
  check('the server stores the time the phone measured', `${mine[0].value}ms` === first.replace(/\s/g, '') && `${mine[2].value}ms` === third.replace(/\s/g, ''), { mine, outcomes })

  await page.waitForSelector('.game-winners', { timeout: 20_000 })
  await page.waitForTimeout(800) // let the result finish fading in
  await page.screenshot({ path: SHOTS + 'quick-draw-result.png' })
  const result = (await page.textContent('.game-screen')).replace(/\s+/g, ' ')
  check('faster side wins: the winners and points are named', /Rayhan & Bot Ben win!\s*\+25 points each/.test(result), result)
  check('MVP is the fastest draw', /MVP: Rayhan \(you\) · \d+ ms draw/.test(result), result)
  await projector.waitForSelector('.battle-winners', { timeout: 10_000 })
  check('projector shows the result', /Rayhan & Bot Ben win!/.test(await projector.textContent('.battle-winners')))
  check('no console errors', page.errors.length === 0 && projector.errors.length === 0, [...page.errors, ...projector.errors])
  await page.evaluate(() => clearInterval(window.__idle))
  await projector.context().close()
  await page.context().close()
}

async function needleRainScenario(browser) {
  console.log('\n# Needle Rain (1 bot already in; joining starts a short shared storm)')
  const page = await newPhone(browser, NEEDLE_SPOT)
  await page.waitForSelector('.bottom-nav')
  await page.evaluate(() => {
    window.history.pushState({}, '', '/game/needle-drop')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.waitForSelector('.needle-record', { timeout: 10_000 })
  check('lobby shows the practice record', /Record to beat: Bot Ana · 12/.test(await page.textContent('.needle-record')))
  await page.click('text=Join the Needle Rain')
  await page.waitForSelector('.needle-field', { timeout: 10_000 })
  await page.keyboard.down('ArrowRight')
  await page.waitForSelector('.needle-result', { timeout: 25_000 })
  await page.keyboard.up('ArrowRight')
  const state = await (await fetch(`${MOCK}/__state`)).json()
  const claims = state.claims.filter((c) => c.drop_id === 'needle-drop')
  const mine = state.gamePlayers.find((gp) => gp.drop_id === 'needle-drop' && !gp.player_id.startsWith('bot'))
  const drop = state.drops.find((d) => d.id === 'needle-drop')
  check('one payout, the drop points, and the drop is claimed', claims.length === 1 && claims[0].points === 40 && drop.status === 'claimed', { claims, status: drop.status })
  check('stored dodges stay inside the cap', mine.dodges <= 32, mine)
  check('no console errors', page.errors.length === 0, page.errors)
  await page.context().close()
}

async function landmarkScenario(browser) {
  console.log('\n# Point to the Landmark (3 bots in the lobby; joining makes 4; 3 rounds)')
  const spot = { lat: OLD_MAIN_LAWN.lat, lng: OLD_MAIN_LAWN.lng - 30 / (M_PER_DEG_LAT * Math.cos((OLD_MAIN_LAWN.lat * Math.PI) / 180)) }
  const page = await newPhone(browser, spot)
  await page.waitForSelector('.bottom-nav')
  // Behave like Android Chrome: no permission prompt, and a compass on deviceorientationabsolute. __aim(trueHeading)
  // points the phone; the app adds State College's -10.5° declination to the magnetic reading, so undo it here.
  // Installed before the app loads, on a full page load (see the Quick Draw scenario for why).
  await page.addInitScript(() => {
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { value: undefined, configurable: true })
    window.__heading = 180
    window.__aim = (heading) => (window.__heading = heading)
    window.__compass = setInterval(() => {
      const magnetic = window.__heading + 10.5 + (Math.random() - 0.5)
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: (((360 - magnetic) % 360) + 360) % 360, beta: 0, gamma: 0, absolute: true }))
    }, 50)
  })
  await page.goto(`${BASE}/game/aim-drop`)
  page.errors = [] // leaving the map page cancels its tile requests; only the game page's errors count
  await page.waitForSelector('.game-kind')
  check('lobby names the game', /Point to the Landmark/.test(await page.textContent('.game-kind')))

  const projector = await newPhone(browser, OLD_MAIN_LAWN)
  // Let the map finish loading first: leaving it mid-load races its fog layers into console errors.
  await projector.waitForSelector('.bottom-nav')
  await projector.goto(`${BASE}/battle/aim-drop`)
  projector.errors = []
  await projector.waitForSelector('.battle-title')

  await page.click('text=Join Point to the Landmark')
  await page.waitForSelector('.calibrate', { timeout: 10_000 })
  check('after joining, it asks for a figure-8 calibration', /figure 8/.test(await page.textContent('.calibrate')))
  await page.click('.calibrate button')

  const rounds = async () =>
    (await (await fetch(`${MOCK}/rest/v1/rpc/get_game_state`, { method: 'POST', body: JSON.stringify({ p_drop_id: 'aim-drop' }) })).json()).rounds
  const offBy = [0, 20, 0]
  const shown = []
  let projectorReveal = Promise.resolve()
  for (const round of [1, 2, 3]) {
    await page.waitForFunction((r) => {
      const screen = document.querySelector('.aim-screen')
      return screen?.dataset.stage === 'pointing' && screen.querySelector('.draw-round')?.textContent === `Round ${r} of 3`
    }, round, { timeout: 20_000 })
    const target = (await rounds())[round - 1]
    if (round === 1) {
      // Reading the landmark's name with the phone held still must not lock in wherever it happens to face.
      await page.waitForTimeout(2500)
      check("holding still without turning doesn't lock", !/Locked in/.test(await page.textContent('.aim-status')))
    }
    // Turn like a player: swing past (120° away) and back, so the phone always turns, wherever it started.
    await page.evaluate((h) => window.__aim((h + 120) % 360), target.bearing)
    await page.waitForTimeout(400)
    await page.evaluate((h) => window.__aim(h), (target.bearing + offBy[round - 1]) % 360)
    check(`round ${round} names the landmark (${target.landmark.name})`, (await page.textContent('.aim-target')) === target.landmark.name)
    const early = await page.waitForSelector('text=Locked in', { timeout: 5_000 }).then(
      () => true,
      async () => {
        const seen = await page.evaluate(() => ({ status: document.querySelector('.aim-status')?.textContent, dial: document.querySelector('.aim-dial')?.getAttribute('aria-label'), aimed: window.__heading }))
        console.log(`INFO round ${round}: no early lock; target ${target.bearing.toFixed(1)}°, phone ${JSON.stringify(seen)}`)
        // A time-out lock goes straight to the reveal, so wait for that instead of "Locked in".
        await page.waitForSelector('.aim-screen[data-stage="reveal"]', { timeout: 4_000 })
        return false
      },
    )
    check(`round ${round} locks early once held steady`, early)
    if (round === 1) await page.screenshot({ path: SHOTS + 'landmark-locked.png' })
    await page.evaluate(() => window.__aim(window.__heading + 90)) // turning after the lock changes nothing
    await page.waitForSelector('.aim-screen[data-stage="reveal"]', { timeout: 6_000 })
    shown.push((await page.textContent('.game-hero')).replace(/\s+/g, ' '))
    if (round === 1) {
      await page.screenshot({ path: SHOTS + 'landmark-reveal.png' })
      // Checked alongside the phone: the slow software-rendered projector mustn't make the phone miss round 2.
      projectorReveal = projector
        .waitForFunction(() => {
          const count = (selector) => document.querySelectorAll(`.landmark-map ${selector}`).length
          return count('.lm-arrow') === 4 && { arrows: 4, trueLine: count('.lm-true'), target: count('.lm-target'), buildings: count('.lm-building') }
        }, null, { timeout: 8_000 })
        .then(async (handle) => {
          const map = await handle.jsonValue()
          check('projector reveal: true line, landmark, real buildings, and all 4 arrows', map.trueLine === 1 && map.target === 1 && map.buildings > 20, map)
          await projector.screenshot({ path: SHOTS + 'landmark-projector.png' })
        })
    }
  }
  await projectorReveal
  check(`the phone shows each round's error (${shown.map((x) => x.match(/\d+°\s*off/)?.[0]).join(', ')})`, shown.every((x) => /\d+°\s*off/.test(x)), shown)
  const state = await (await fetch(`${MOCK}/__state`)).json()
  const mine = state.results.filter((r) => r.drop_id === 'aim-drop' && !r.player_id.startsWith('bot')).sort((a, b) => a.round - b.round)
  check('the server scored my headings against the true bearing (~0°, ~20°, ~0°)', mine.length === 3 && mine[0].value < 3 && Math.abs(mine[1].value - 20) < 3 && mine[2].value < 3, mine)

  await page.waitForSelector('.game-winners', { timeout: 20_000 })
  await page.waitForTimeout(800) // let the result finish fading in
  await page.screenshot({ path: SHOTS + 'landmark-result.png' })
  const result = (await page.textContent('.game-screen')).replace(/\s+/g, ' ')
  check('closer side wins: the winners and points are named', /Rayhan & Bot Ben win!\s*\+35 points each/.test(result), result)
  check('MVP is the most accurate point', /MVP: Rayhan \(you\) · \d+° off/.test(result), result)
  await projector.waitForSelector('.battle-winners', { timeout: 10_000 })
  check('projector shows the result', /Rayhan & Bot Ben win!/.test(await projector.textContent('.battle-winners')))
  check('no console errors', page.errors.length === 0 && projector.errors.length === 0, [...page.errors, ...projector.errors])
  await page.evaluate(() => clearInterval(window.__compass))
  await projector.context().close()
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
  await photoHuntScenario(browser)
  await shakeOffScenario(browser)
  await quickDrawScenario(browser)
  await needleRainScenario(browser)
  await landmarkScenario(browser)
  await searchScenario(browser)
  await campusEventsScenario(browser)
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
