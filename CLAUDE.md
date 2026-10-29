# WalkPSU

HackPSU project: a mobile-first web app that turns the Penn State (University Park) campus map into a live game board.

- **Admins** drop events on the campus map: Shake-Offs (`minigame`), photo hunts, check-ins. They can clear any drop from its sheet (`close_drop`: marks it expired, so earned points stay).
- **Meetups:** any player can pin "volleyball here right now" at their position for 30 min to 2 h (the map's "+ Meetup" button). A social pin with no points; one live meetup per player, and they can end it themselves.
- **Players compete as individuals.** There are no permanent teams, and each player gets a server-assigned map color. They race to a drop to claim it: inside the claim radius by GPS, or anywhere by scanning the drop's QR code (indoors, where GPS is unreliable).
- Claims award points. A drop can sit at a campus building, and the map highlights that building in the accent color while the drop is active. Buildings are never owned or captured.
- The leaderboard ranks players by points, live. Opted-in players appear live on the map (Realtime Presence).
- **Walking:** my trail (today, `localStorage` only) fades behind my sprite; others get a faint 2-minute tail from Presence. **Fog of war** covers 150 campus hexes (120 m edges, `map/hexgrid.ts`); walking into one with a good GPS fix discovers it (`discovered_areas`). Profile shows distance walked today, the fog toggle, and areas discovered.
- **Live Discover events:** `/api/sync-events` (Supabase pg_cron, every 30 min, `DISCOVER_SYNC_SECRET`; or `npm run sync-events`) fetches Penn State Discover into `discover_events`. Building placement is by name, then pin, then Gemini for leftover location text (cached in `discover_locations`, answers checked against real building numbers). Missing events count as cancelled only on a complete fetch. Seeded drops follow their event: rescheduled, or closed when it's cancelled (never deleted). The sync never creates drops. Logic lives in `api/_discover.ts`, shared with `npm run import-events`. **On the map**, events starting within a week (`useUpcomingEvents`, polled every 5 min; multi-day listings skipped) get one pin per building in the color of its soonest event's type (`EVENT_THEMES` in `lib/campus.ts`; `event-points`, under every drop layer) and a pale blue building tint (`CampusMap`'s `tinted`; the orange highlight wins). An event that is a seeded drop shows only as the drop. Tapping a pin glides in and opens `EventSheet` with "Also here" for the building's other events, plus **RSVPs**: "12 going" and an "I'm going" toggle (`event_going`/`set_going`). It's WalkPSU's own RSVP system (the goal is to replace Discover), so Discover's `rsvpTotal` is never used, and players see counts only, never who is going. The search sheet lists "Coming up on campus" before you search. The map's ⓘ (top left) opens `MapKeySheet`: every event type's color, the drop colors, and what orange and blue buildings mean. Keep it in step with `EVENT_THEMES`, `DROP_TYPES`, and MapPage's pin colors.
- **Profile and "For you":** Profile's "About you" card saves a major (free text, `MAJORS` suggestions) and interests (14 chips) to the player's **private** `player_profiles` row. `lib/interests.ts` maps each interest to Penn State Discover's own keywords (categories, themes, the "Free Food"/"Free Stuff" benefits) plus title words; a major matches by word stem and some majors hint at an interest (CS → Tech, worth less). The search sheet shows "For you" (top 5, each saying why) above "Coming up", or a "Get picks for you" nudge; an event card shows "★ For you · Career". Matching runs on the phone; profiles never leave the player's row.
- **AI event search:** the map's "Find events you'd like…" pill opens a search over `discover_events` (or the bundled snapshot `scripts/data/discover-events.json` until the first sync). `/api/search-events` sends Gemini the upcoming events and the query, validates the returned ids, and the app shows each result's reason. Picking one flies to and lights its building with an event card; a result that is one of our seeded drops (`source_id = 'discover:<id>'`) opens that drop's card instead. The same Gemini call also picks which **live drops** fit (the client sends their titles and building names, never coordinates): they're listed first ("Live on the map") and the map narrows to them, with the status pill showing "Showing N of M" and a ✕ to clear (a search that matched no live drop leaves the map alone). When Gemini can't answer (out of credits, overloaded, garbled), `api/_keywordSearch.ts` answers instead (synonyms, emoji, "tonight"/"this weekend") and the sheet labels the results as keyword matches. Queries are never stored or logged.
- **Achievements:** leaderboard badges worked out from a player's points (`lib/achievements.ts`: 100, 500, 1,000); nothing is stored.
- **Photo hunt:** the admin posts a reference photo of a spot plus a twist ("with a thumbs up"). Players see only a 250 m search circle, find the spot, and take a photo there; Gemini (`web/api/verify-photo.ts`) judges it. The first finder gets full points and reveals a red pin; the hunt then stays open 7 minutes, each later finder getting half the points of the one before.
- **Shake-Off:** players join a lobby at the drop (in range or by QR). At 4 joins (or an admin's Start) they're dealt into Blue vs White **for that game only** and shake their phones for 15 s. The side with more shakes per player wins, and every winner gets the drop's points. Phones show a named tug-of-war, and `/battle/:dropId` is the projector view.
- **Needle Rain:** the same join rules and the same `/game` and `/battle` routes, chosen with `drops.game = needle_rain` (existing minigame rows stay Shake-Offs). At 2 joins the round starts after a short countdown. Every phone simulates one storm from the public `round_seed` and `started_at` (no per-device `Math.random()`). Tilt dodges; a joystick and arrow keys / WASD are the fallback. A hit freezes that player's dodge count; last one standing wins, and a timer tie goes to the higher count (an exact tie uses the seeded coin flip). The winner gets one claim worth the drop's points. The loser gets nothing. A solo practice run uses `ghost_seed`, pays 0, and leaves the drop open. No rematch.
- **Mini-game kinds:** a `minigame` drop's `game` picks what its lobby plays (admin picker; default Shake-Off). **Quick Draw:** 3 rounds; every phone flashes "DRAW!" at the same seeded server moment, phones time the flick themselves, and the side with the lower average best time wins (MVP: fastest draw). **Point to the Landmark:** 3 rounds, each naming a famous landmark 200 m+ from the drop; players point their phone (compass, after a figure-8 calibration; no compass = spectate) and lock by holding steady 1 s (or at 8 s). The server scores the angular error from the true bearing measured from the drop; lower average error wins (MVP: closest point). The projector reveals a north-up map with the true line and everyone's arrows. Shake-Off, Quick Draw, and Point to the Landmark share sides and pay every winner. Needle Rain does not use sides.

Judging requirements: rivalry, phone motion, and the game working for **4+ players in total**. Never enforce a minimum group size. Never add permanent teams; Shake-Off sides are derived per game (`game_sides()`), never stored. Never pay a campus point per needle, never store live locations, and never bring back building capture.

## Stack

- **Frontend:** React 19 + Vite + TypeScript in `web/`, react-router, ESLint (no Prettier config: match existing style, single quotes, no semicolons).
- **Map:** MapLibre GL 6 via `react-map-gl/maplibre` on OpenFreeMap Positron (no API key). The view is 2.5D Life360-style: pitch 45°, bearing −17°, `buildings.geojson` extruded 10–15 m, and buildings with an active drop in accent orange with a pulse. Claim circles and drops are GeoJSON sources and layers; tapping a drop opens `DropSheet` (a non-modal Vaul bottom sheet). Players, including me, are DOM `Marker` sprites (`PlayerSprite`): round faces in the player's color that breathe, blink, and hop-glide to each presence update (WAAPI/CSS transforms only, off under reduced motion). Tapping a sprite opens a `Popup` name tag.
- **Buildings:** 958 University Park footprints from PASDA, simplified into the static `web/public/data/buildings.geojson` (`npm run fetch-buildings` regenerates it; never fetch PASDA at runtime). Buildings are keyed by PSU building number `num`; the DB stores only that.
- **Backend:** Supabase: Postgres + RLS, Realtime (postgres_changes, broadcast, presence), Storage (`drop-hints` bucket).
- **Auth:** Auth0 via Supabase third-party auth. Supabase verifies the Auth0 **ID token**, which an Auth0 Action stamps with `role: authenticated` and `app_role`. When `VITE_AUTH0_*` is empty, the app falls back to Supabase anonymous sign-in plus an "enter your name" screen. Both give RLS a JWT `sub`, so policies are identical.
- **Deploy:** Vercel, Root Directory `web`. `web/vercel.json` holds the SPA rewrite. Secret-key code goes in `web/api/`: `verify-photo.ts` (Gemini + service-role key), `search-events.ts` (Gemini only), and `sync-events.ts` (Discover + Gemini + service-role key, called by pg_cron), sharing `_shared.ts` (auth as the calling player, Gemini with retry and model fallback inside a 25 s budget, `GeminiError` kinds busy/unavailable/garbled; the `_` keeps Vercel from serving it) and `_discover.ts`. `vercel.json` gives `api/*.ts` a 60 s `maxDuration` and bundles `public/data/buildings.geojson` (read from disk by `_discover.ts`). `npm run dev` serves `web/api/*.ts` too, via the `apiRoutes` plugin in `vite.config.ts`.

## Layout

```
web/
  public/data/         buildings.geojson (generated, committed)
  scripts/             fetch-buildings.mjs (PASDA → simplified GeoJSON, mapshaper)
  tests/               sql/ (PGlite), api/ (verify-photo vs. the mock), mock/ (fake Supabase), e2e/ (headless Edge on a production build)
  src/
    App.tsx            routes; bottom nav hidden on /game and /battle
    pages/             Map, Leaderboard, Profile, Admin (/admin), Claim (/claim/:dropId?key=), JoinScreen,
                       Game (/game/:dropId), Battle (/battle/:dropId)
    game/              Mini-games: kinds.ts + GameIcon (names, blurbs, icons), shakeoff.ts (phase model, side math, names),
                       useGame (state + clock offset), motion.ts (shared DeviceMotion permission), useShakes,
                       useShakeBroadcast, TugBar, Results (winner headline + MVP), quickdraw.ts (scoring),
                       useQuickDraw (signal scheduling, on-phone timing), QuickDrawScreens, compass.ts (useCompass:
                       iOS/Android heading, magnetic → true), landmark.ts (scoring), useLandmarkAim (steady lock),
                       LandmarkScreens (play, projector board, SVG reveal map),
                       needleRain.ts (shared storm), useSteer, useNeedleBroadcast, NeedleField, NeedleRainGame, NeedleBattle
    session/           SessionProvider (Auth0 or anonymous), PresenceProvider (the only GPS watcher; `subscribe` for every fix),
                       TrailProvider (my trail + others' tails), DiscoveryProvider (fog-of-war areas)
    components/        CampusMap (MapLibre wrapper), DropSheet, PlayerSprite, WalkLayers (fog + trails), BuildingPicker, DropQrList, BottomNav
    map/               basemap.ts (declutter + landmarks), geometry.ts (geodesic circles, heights), hexgrid.ts (fog areas), worker.ts
    lib/               supabase.ts, api.ts (all DB calls), hooks.ts, geo.ts, buildings.ts, database.types.ts
supabase/migrations/   SQL, applied in filename order
docs/                  SCHEMA.md (tables/functions, keep current), SETUP.md (Supabase/Auth0/Vercel steps)
```

## Migrations (run in this order in the Supabase SQL Editor; never edit an applied one)

1. `20261024000000_init.sql`: teams, players, drops, claims, RLS, `claim_drop`, `distance_m`, `drop-hints` bucket.
2. `20261024010000_territory_and_qr.sql`: `drops.building_num`, building capture, `drop_secrets` (QR codes).
3. `20261024020000_individual_players.sql`: drops teams, adds `players.color`, `claim_radius_m()`, `player_scores`.
4. `20261024030000_shake_off.sql`: `games`, `game_players`, Shake-Off functions, claims unique per (drop, player).
5. `20261024040000_remove_building_capture.sql`: drops `building_control` and the capture logic.
6. `20261024050000_event_drops.sql`: `drops.subtitle`, `starts_at`, `source_id` (drops seeded from Penn State Discover events).
7. `20261024060000_photo_hunt.sql`: hunt columns, hidden spot in `drop_secrets`, `claims.points`, `create_photo_hunt`, service-only `photo_hunt_check`/`claim_photo_hunt`, `current_player_id`.
8. `20261025000000_discovered_areas.sql`: fog-of-war `discovered_areas (player_id, hex_id)` (own rows only) and `discover_area()`.
9. `20261025010000_meetups.sql`: `meetup` drop type, `create_meetup()` (any player), `close_drop()` (admins any drop, players their own meetup), `claim_drop` refuses meetups.
10. `20261025020000_quick_draw.sql`: `drops.game` (mini-game kind), `game_results`, `minigame_settings()`, `submit_reaction`, per-kind `finish_game` (`side_scores`).
11. `20261025030000_landmark.sql`: `landmark` game kind, `campus_landmarks`, `game_results.heading`, `bearing_deg`, `landmark_rounds`, `submit_heading`.
12. `20261025030000_needle_rain.sql`: `drops.game` includes `needle_rain`, dodge and ghost columns, `submit_dodges`, `submit_ghost`, one-winner `finish_game`. Applied after the landmark file (filename order).
13. `20261025040000_event_search.sql`: `search_quota` (a per-player counter, no query text) and `use_search_quota()` (10 searches per 10 minutes) for AI event search.
14. `20261028000000_discover_sync.sql`: `discover_events` (players read), `discover_locations` (Gemini placement cache, service only), service-only `sync_discover_events()` (upsert, cancel on complete fetch, seeded drops follow their event).
15. `20261028010000_event_rsvps.sql`: `event_rsvps` (own rows only), `event_going()` (counts, never who), `set_going()` (on/off, refuses ended or cancelled events).
16. `20261028020000_player_profiles.sql`: private `player_profiles` (major, interests checked against `INTERESTS`), `discover_events.benefits`, and `sync_discover_events()` replaced to store benefits.

Every schema change is a new migration. Update `docs/SCHEMA.md` and `web/src/lib/database.types.ts` (hand-written) in the same commit.

## Rules (don't break these)

- Authorization lives in RLS and `security definer` functions. Clients write only through functions; direct writes to `claims`, `games`, and `game_players` are blocked. The anon key is public.
- `claim_drop` refuses `minigame` drops. Shake-Off payout happens only in `finish_game`.
- `claim_drop` also refuses `meetup` drops: anyone can post one, so they must never be worth points. Players post them only through `create_meetup` (drops inserts stay admin-only), and clearing goes through `close_drop`, never a delete (claims cascade on delete and would erase points).
- `claim_drop` also refuses `photo_hunt` drops. Hunt claims come only from `claim_photo_hunt`, which only the service role (`web/api/verify-photo.ts`, after Gemini) may call. Until the first find, a hunt's `lat`/`lng` is a decoy search-circle center and its `building_num` is null; never expose `drop_secrets.hunt_*` to players.
- Scores sum `claims.points`, not `drops.points`.
- The GPS radius exists only in SQL `claim_radius_m()`; the client reads it (`useClaimRadius`). Never hard-code 60. `distanceM` (TS) must stay identical to SQL `distance_m` (same haversine, R = 6,371 km).
- Mini-game timing and caps come from `get_game_state().settings` plus `server_now` (clock-skew offset, from the lowest-latency sample). Never hard-code 15 s, 8 shakes/s, Quick Draw's rounds and delays, Needle Rain's 40 s and dodge cap, or Landmark's rounds and steady window. Broadcast counts are cosmetic; only capped `submit_shakes` totals, `game_results`, and capped `submit_dodges` decide winners. Needle Rain's private `games.seed` stays hidden and only breaks ties; the public `round_seed` is what every phone simulates.
- Quick Draw signal moments and Landmark picks are derived from `games.seed` and `started_at` (`quick_draw_signal_at`, `landmark_rounds`), never stored or timed by a server process. Reaction times and headings are measured on the phone; the server bounds them and computes the landmark error itself.
- Compass headings are magnetic; `game/compass.ts` converts to true north with State College's declination (−10.5°). Landmark bearings are true and measured from the drop, never from the phone's GPS.
- Claim codes live only in `drop_secrets` (admin-read). Never put them in `drops`.
- Live locations go only over the Presence channel `campus`; never store them. Read position from `usePresence()` and never start a second geolocation watcher. Code that must see every fix (trails, discovery) uses `usePresence().subscribe`. My trail stays in `localStorage`; `discovered_areas` holds only (player, hex), never times or coordinates.
- Components call Supabase only through `lib/api.ts`. Live data uses `useLiveQuery`; call `refresh()` after your own writes (venue Wi-Fi drops Realtime). `useGame` also polls every 2 s.
- Player names are user input. React escapes them; anything put into raw HTML must be escaped.
- Phones first: `100dvh`, safe-area insets, 48 px touch targets.

## Fragile: read before touching

- **Gemini time budget and model order.** `askGeminiJson` tries `gemini-flash-lite-latest`, then `gemini-flash-latest`, then lite again, each for at most 12 s, and gives up after `GEMINI_BUDGET_MS` (25 s) in all, counting that as busy. Lite goes first because it answers search's ~300-event prompt in 1–2 s, while `gemini-flash-latest` took 13 s to over 55 s (Oct 2026). Vercel stops a function at 60 s and the player then gets no answer at all ("The event finder took too long"), so keep every Gemini call well under the limit and leave room for the fallback. Measure a real search before reordering.
- **`web/tsconfig.json`'s `rewriteRelativeImportExtensions` (do not remove).** `web/api/*.ts` import each other as `./_shared.ts` (Node runs `.ts` directly for scripts and tests). Vercel's `@vercel/node` compiles each file to `.js` using the options in the `tsconfig.json` nearest the function, which is `web/tsconfig.json` (not `tsconfig.node.json`). Without this option the built code still imports `./_shared.ts`, and every `/api` function crashes on load with `FUNCTION_INVOCATION_FAILED` while working fine locally.
- **MapLibre worker (do not remove).** MapLibre 6 loads its worker from a separate file, and `src/map/worker.ts` registers it (`setWorkerUrl` with a Vite `?worker&url` import). Without it, production shows a blank map ("Worker failed to load"). `npm run test:e2e` builds for production and fails if this breaks. `optimizeDeps.exclude: ['maplibre-gl']` in `vite.config.ts` is extra insurance for dev; MapLibre otherwise depends on Vite's dep cache being fresh.
- After installing or removing deps while `npm run dev` runs, Vite's dep cache can go stale (504 "Outdated Optimize Dep", or imports of deleted packages) and the page goes blank. Stop the server, `rm -rf web/node_modules/.vite`, and restart.
- **Vaul 1.1.2 + controlled `open`:** Vaul doesn't pass `modal={false}` to Radix, so opening the sheet from code leaves `pointer-events: none` on `<body>` (map untappable). `DropSheet` resets it; keep it (`components/useNonModalSheet.ts`, used by every non-modal sheet).
- **Sprites:** `PlayerSprite` FLIPs from the old screen position in a `useLayoutEffect` (react-map-gl moves the marker during render). Don't put CSS `filter`s on the breathing element; a drop-shadow there cost ~25% fps.
- **Fog layer order:** `WalkLayers` adds the fog with `beforeId: 'buildings-active-glow'` so it sits under the glow, claim circles, drops, trails, and sprites. Layers mount in JSX order, so keep `<WalkLayers />` first among `MapPage`'s map children, and don't mount map sources conditionally (a late mount lands on top). Hex ids come only from the constants in `hexgrid.ts`; changing the edge or origin orphans every stored discovery.
- `map.loaded()` stays false forever because the highlight pulse keeps a paint transition running. Use `isStyleLoaded()` plus rendered features instead.
- react-map-gl's `Map` takes no `className`; `CampusMap` wraps it in a sized `div`. `maxBounds` must be a flat `[w, s, e, n]`.
- `campusBounds` deliberately ignores far-off PASDA property (Ag Progress Days, the airport) by keeping buildings within 2.5 km of the median building, then pads by 1.6 km.
- In `game_sides`, `finish_game`, and `submit_shakes`, phase is derived from `started_at` (no server timer), and `finish_game` is idempotent and retried by every client. Keep both properties.
- Building names in PASDA are formal ("Hetzel Union Building (Ralph Dorn)"). `BUILDING_NICKNAMES` in `lib/campus.ts` makes HUB, BJC, and IST searchable, and `LANDMARKS` in `map/basemap.ts` labels the map.

## Tests (`web/tests/`)

Run `npm test` in `web/` (unit + SQL + API + e2e, a few minutes), plus `npm run lint` and `npm run build`, before every commit.

- **`npm run test:unit`:** `tests/unit/interests.test.mjs` checks "For you" matching (Discover categories, themes, benefits, title words, major stems, hints, ranking) and that `INTERESTS` matches the migration's check constraint.
- **`npm run test:sql`:** runs migrations in PGlite (in-process Postgres) and checks behavior through real RLS. `tests/sql/harness.mjs` stubs Supabase (`anon`/`authenticated` roles, `auth.jwt()` from `request.jwt.claims`, storage tables, the `supabase_realtime` publication, and Supabase's default table grants via `alter default privileges`). It also provides `actor(db)(sub, claims, sql)` to act as a user and `superuser(db)` for setup and time travel (move `games.started_at` into the past).
  - `current-schema.test.mjs`: all migrations applied. Joining, RLS, claims, the 59 m/61 m boundary, QR codes, scores, and the full Shake-Off lifecycle.
  - `meetups.test.mjs`: posting rules (length, on campus, one live meetup, 5/hour, 15–180 min), no points by GPS or QR, and `close_drop` permissions (admins any drop, players only their own meetup; points survive).
  - `event-search.test.mjs`: the search rate limit (10 per 10 minutes, per player, resets), counters unreadable by players, no query column.
  - `player-profiles.test.mjs`: own-row-only read/insert/update, no deletes, interest and major checks, cascade, and that the sync stores benefits and stays service-only.
  - `event-rsvps.test.mjs`: going on/off and counts, `event_going` never exposes who, own-rows-only reads, no direct writes, refusals (ended, cancelled, unknown, not joined), cascades.
  - `discover-sync.test.mjs`: `sync_discover_events` is service-only, players read but never write events, the location cache is server-only, truncated fetches cancel nothing, seeded drops reschedule and close with their event (points survive, closed stays closed), ended events aren't "cancelled", 30-day pruning.
  - `discovery.test.mjs`: `discovered_areas` RLS (own rows only, no edits/deletes, anon blocked), duplicate-ignoring `discover_area`, hex id format, cascade on player delete.
  - `quick-draw.test.mjs`: `drops.game` defaults, the seeded round schedule, every `submit_reaction` refusal, first-result-final, best-time scoring with a false starter.
  - `needle-rain.test.mjs`: `claim_drop` refuses a Needle Rain, a solo ghost pays 0 and leaves the drop active, a two-player finish pays the winner once and caps an inflated dodge count, and an old Shake-Off still finishes by shakes.
  - `landmark.test.mjs`: `bearing_deg`/`angle_diff`, landmark picks (distinct, 200 m+, never the drop's own building), bearings from the drop, every `submit_heading` refusal, error scoring with a no-show.
  - `photo-hunt.test.mjs`: hidden spot, admin-only creation, service-only claiming, halving points, reveal, 7-minute window.
  - `migration-paths.test.mjs`: builds data under an older schema, upgrades, and checks nothing is lost (teams to individuals; capture removal; per-claim points). Add a block here for any migration that rewrites data.
  - `distance-parity.test.mjs`: TS `distanceM` against SQL `distance_m` near the radius.
- **`npm run test:api`:** `search-events.test.mjs` runs the real `web/api/search-events.ts` against the mock with Gemini faked and the clock pinned to the snapshot: auth, query limits, id validation (unknown, ended, duplicate), the 6-result cap, empty and garbled answers, busy Gemini, the rate limit, and that no query is logged. `verify-photo.test.mjs` runs the real `web/api/verify-photo.ts` against the mock Supabase with Gemini faked at the `fetch` level: auth, cheap checks before any Gemini call, each verdict field, retry on 503, halving points, and that players can't call the service-only hunt functions. `gemini-timeout.test.mjs` shortens the budget to 3 s and each attempt to 1 s, and checks the model order, that a hanging model (or a body that never finishes), a busy one, and a retired one each give way to the next, that a bad key stops at once, that everything ends inside the budget, and that search answers with keyword matches when no model does. `sync-events.test.mjs` runs the real `web/api/sync-events.ts` against the mock with Discover and Gemini faked: the shared secret, which locations reach Gemini (never online, matched, or other-campus ones), invalid building numbers, the cache, a Gemini outage, the 5-page truncation, a Discover outage, and search reading the synced events.
- **`npm run test:e2e`:** starts `tests/mock/supabase.mjs`, makes a **production build** pointed at it (`VITE_E2E=1`, output in `node_modules/.cache/e2e-dist`), serves it with `vite preview` on 5199, and drives headless **Microsoft Edge** through `playwright-core` (`E2E_BROWSER_CHANNEL=chrome` to switch) at 375×812, DPR 2, touch, with granted geolocation. It covers nine scenarios:
  - **Map:** camera, layers, highlight, claim in range, bounds, recenter, leaderboard, admin tap-to-place.
  - **Photo hunt:** the search circle hides the spot, the card shows the twist, a photo is "taken" (the mock's `/__verify-photo` stands in for Gemini via `page.route`), and the red pin and countdown appear.
  - **AI event search:** example prompts, results (reason, online event, claimable drop), flying to and lighting the building with its card, a claimable result opening the drop's card, "Nothing matched", and a busy error. The mock's `/__search-events` stands in for the API via `page.route`.
  - **Campus events:** seeds events through the mock's `sync_discover_events`, then checks one pin per building in its event type's color (none for online, seeded-drop, over-a-week, or multi-day events), the building tint, that tapping a pin zooms in and opens the soonest event with "Also here", the going count (2 bots RSVP'd) and the I'm going toggle on and off, the "Get picks for you" nudge into Profile, saving a major and interests, "For you" ranking with reasons, the card's For you tag, and the search sheet's "Coming up on campus" list.
  - **Meetups (runs last):** posts a meetup from the "+ Meetup" sheet, checks its card (no points, no claim circle), ends it with the two-tap confirm, then clears the revealed photo hunt as an admin.
  - **Shake-Off:** joins as the 4th player with 3 bots and shakes via synthetic `DeviceMotionEvent`s (after deleting `DeviceMotionEvent.requestPermission`, which desktop Chromium answers "denied"), then checks the named winners and MVP.
  - **Quick Draw:** joins `draw-drop` as the 4th player, flicks after each "DRAW!" (and once too early), checks the false start, that the server stored the phone's times, the projector's live ranking, and the winners and MVP. The mock's bots are deliberately slow (1.2–1.4 s) so the result doesn't depend on machine speed.
  - **Needle Rain:** joins `needle-drop` (one bot already in, open ground so no building highlight), dodges with the arrow key, and checks a single claim for the drop's points. It does not assert who won. The mock shortens the round; the client reads that duration from settings.
  - **Point to the Landmark:** a synthetic compass (`deviceorientationabsolute`) aims at each round's true bearing (20° off in round 2), checks the figure-8 step, the steady lock, the server's errors, the projector's reveal map (true line, landmark, buildings, 4 arrows), and the winners and MVP.

  Screenshots land in `tests/e2e/screenshots/` (gitignored). It also prints frame rate (software WebGL, so a phone GPU will differ).
- **`npm run mock`:** runs the mock alone on :54321 for manual testing with `VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=mock npm run dev`. The mock mirrors the SQL rules (radius, QR, Shake-Off timing with a 4 s countdown, caps, 3 bots) but isn't authoritative; `tests/sql` is. It has **no Realtime**, which is why the app's `refresh()`/poll fallbacks matter. `GET /__state` dumps its data.
- The map handle `window.__walkpsuMap` exists only in dev or a `VITE_E2E` build; normal production builds strip it. The in-app browser pane often stops firing `requestAnimationFrame`, so MapLibre never renders there. Use the e2e suite or a real browser instead.
- Changing the schema or an RPC means updating the mock too, or the e2e run breaks.

## Windows environment gotchas

- The shell is Git Bash on Windows. Long heredocs containing JSX or quotes sometimes fail ("unexpected EOF while looking for matching `'`"). Write the script to a file with the Write tool, or use Write/Edit directly.
- Python's default encoding is cp1252, which corrupts or truncates files containing `→`, `…`, or emoji. Always use `PYTHONUTF8=1` and `open(..., encoding='utf-8')`.
- Running `npx prettier` uses default config (double quotes, semicolons) and restyles files. Don't.
- `git checkout -- <file>` reverts to the last commit and throws away uncommitted edits. To undo an experiment, edit it back instead.
- Node can't import `C:/...` paths as ESM; use `file:///C:/...`. Node 24 runs `.ts` files directly (type stripping).
- Git warns "LF will be replaced by CRLF" on every commit. It's harmless.
- A teammate (shiyx1224-shi) also pushes to `main`. `git fetch` before pushing and merge (never force-push).

## Commands (from `web/`)

```bash
npm install
npm run dev              # dev server (5173, or 5174 if taken)
npm run build            # typecheck + production build
npm run lint
npm run fetch-buildings  # regenerate public/data/buildings.geojson
npm run import-events    # snapshot Penn State Discover events → scripts/data/discover-events.json
npm run sync-events      # one live sync into discover_events (service-role key; Gemini key to place leftovers)
npm run seed-events      # seed 12 of them as check-in drops (service-role key; --dry-run, --clear)
npm test                 # test:sql + test:e2e (needs Microsoft Edge, or E2E_BROWSER_CHANNEL=chrome)
npm run mock             # mock Supabase on :54321 for manual UI testing
npm run test-gemini -- <reference.jpg> <photo.jpg> ["twist"]   # try the photo-hunt referee on local photos
```

Copy `web/.env.example` to `web/.env`. `VITE_*` vars ship to the browser; secrets must not use that prefix. Never commit `.env`.
