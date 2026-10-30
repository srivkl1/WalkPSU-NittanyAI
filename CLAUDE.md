# WalkPSU

HackPSU project: a mobile-first web app that puts Penn State (University Park) campus life on a live map. Students find events worth walking to and check in when they get there; clubs see who's interested, who came, and who came back.

- **Admins** drop check-ins on the campus map (Admin page). They can clear any drop from its sheet (`close_drop`: marks it expired, so its check-ins stay). They also approve club organizers.
- **Meetups:** any player can pin "volleyball here right now" at their position for 30 min to 2 h (the map's "+ Meetup" button). A social pin with nothing to check in to; one live meetup per player, and they can end it themselves.
- **Checking in:** inside a drop's radius by GPS, or anywhere by scanning its QR code (indoors, where GPS is unreliable). Once per player per drop; the drop stays open for everyone else. A check-in counts as attendance. A drop can sit at a campus building, and the map highlights that building in the accent color while the drop is active. Buildings are never owned or captured.
- **Mini-games, photo hunts, points, the leaderboard and achievements were removed on purpose** (2026-10-29, `20261029000000_remove_games_and_points.sql`). Their old tables and rows stay in the database, unread. Don't bring them back without asking.
- Each player gets a server-assigned map color. Opted-in players appear live on the map (Realtime Presence).
- **Walking:** my trail (today, `localStorage` only) fades behind my sprite; others get a faint 2-minute tail from Presence. **Fog of war** covers 150 campus hexes (120 m edges, `map/hexgrid.ts`); walking into one with a good GPS fix discovers it (`discovered_areas`). Profile shows distance walked today, the fog toggle, and areas discovered.
- **Live Discover events:** `/api/sync-events` (Supabase pg_cron, every 30 min, `DISCOVER_SYNC_SECRET`; or `npm run sync-events`) fetches Penn State Discover into `discover_events`. Building placement is by name, then pin, then Gemini for leftover location text (cached in `discover_locations`, answers checked against real building numbers). Missing events count as cancelled only on a complete fetch. Seeded drops follow their event: rescheduled, or closed when it's cancelled (never deleted). The sync never creates drops, and it keeps old events that someone RSVP'd or checked in to (club history). Logic lives in `api/_discover.ts`, shared with `npm run import-events`. **On the map**, events starting within a week (`useUpcomingEvents`, polled every 5 min; multi-day listings skipped) get one pin per building in the color of its soonest event's type (`EVENT_THEMES` in `lib/campus.ts`; `event-points`, under every drop layer) and a pale blue building tint (`CampusMap`'s `tinted`; the orange highlight wins). An event that is a seeded drop shows only as the drop. Tapping a pin glides in and opens `EventSheet` with "Also here" for the building's other events, plus **RSVPs**: "12 going" and an "I'm going" toggle (`event_going`/`set_going`). It's WalkPSU's own RSVP system (the goal is to replace Discover), so Discover's `rsvpTotal` is never used, and players see counts only, never who is going. The search sheet lists "Coming up on campus" before you search. The map's ⓘ (top left) opens `MapKeySheet`: every event type's color, the drop colors, and what orange and blue buildings mean. Keep it in step with `EVENT_THEMES`, `DROP_TYPES`, and MapPage's pin colors.
- **Event check-ins:** from 30 minutes before an event until it ends, its card has a "Check in" button (GPS within the radius of its building) and the club's door QR code (`/checkin/:eventId?key=`) works from anywhere (`check_in_event`). Checking in at a seeded drop checks you in to its event too (a trigger on `claims`).
- **Reminders:** `EventReminders`, top left of the map beside ⓘ: when an event I RSVP'd to, or one of my top "For you" picks, starts within the hour or is on now (and I haven't checked in), a card says "Starts in 12 min · You're going". Tap to fly there; ✕ dismisses it (ids in `localStorage`). Worked out on the phone; nothing is sent.
- **Clubs:** a club is a Discover `organization`. A player taps "Run <club>? Get its dashboard" on one of its events (`request_organizer`, with their role); an admin approves on the Admin page (`decide_organizer_request`). Organizers (and every admin) get a Clubs tab (`/clubs`) and a dashboard per club (`/clubs/:organization`): the **second-visit rate** (players who checked in to 2+ of the club's events ÷ players who checked in at all), tiles for Interested / RSVP'd / Checked in / Came back, upcoming events with their counts and door QR codes, past events with how many came, and "Next event ideas". Everything is **counts only, never who** (`club_stats`). "Interested" and the ideas come from `/api/club-insights`: interested = RSVP'd or profile matches (`matchEvent`, server-side with the service key, counts only); ideas = Gemini over aggregated numbers, or `suggestSlots` from the numbers alone when Gemini can't answer (labeled).
- **Profile and "For you":** Profile's "About you" card saves a major (free text, `MAJORS` suggestions) and interests (14 chips) to the player's **private** `player_profiles` row. `lib/interests.ts` maps each interest to Penn State Discover's own keywords (categories, themes, the "Free Food"/"Free Stuff" benefits) plus title words; a major matches by word stem and some majors hint at an interest (CS → Tech, worth less). The search sheet shows "For you" (top 5, each saying why) above "Coming up", or a "Get picks for you" nudge; an event card shows "★ For you · Career". Matching runs on the phone; the only server-side reader of profiles is `/api/club-insights`, which returns counts.
- **AI event search:** the map's "Find events you'd like…" pill opens a search over `discover_events` (or the bundled snapshot `scripts/data/discover-events.json` until the first sync). `/api/search-events` sends Gemini the upcoming events and the query, validates the returned ids, and the app shows each result's reason. Picking one flies to and lights its building with an event card; a result that is one of our seeded drops (`source_id = 'discover:<id>'`) opens that drop's card instead. The same Gemini call also picks which **live drops** fit (the client sends their titles and building names, never coordinates): they're listed first ("Live on the map") and the map narrows to them, with the status pill showing "Showing N of M" and a ✕ to clear (a search that matched no live drop leaves the map alone). When Gemini can't answer (out of credits, overloaded, garbled), `api/_keywordSearch.ts` answers instead (synonyms, emoji, "tonight"/"this weekend") and the sheet labels the results as keyword matches. Queries are never stored or logged.

Never add permanent teams, never store live locations, never bring back building capture, and never show anyone (organizers included) who RSVP'd, checked in, or is interested.

## Stack

- **Frontend:** React 19 + Vite + TypeScript in `web/`, react-router, ESLint (no Prettier config: match existing style, single quotes, no semicolons).
- **Map:** MapLibre GL 6 via `react-map-gl/maplibre` on OpenFreeMap Positron (no API key). The view is 2.5D Life360-style: pitch 45°, bearing −17°, `buildings.geojson` extruded 10–15 m, and buildings with an active drop in accent orange with a pulse. Check-in circles and drops are GeoJSON sources and layers; tapping a drop opens `DropSheet` (a non-modal Vaul bottom sheet). Players, including me, are DOM `Marker` sprites (`PlayerSprite`): round faces in the player's color that breathe, blink, and hop-glide to each presence update (WAAPI/CSS transforms only, off under reduced motion). Tapping a sprite opens a `Popup` name tag.
- **Buildings:** 958 University Park footprints from PASDA, simplified into the static `web/public/data/buildings.geojson` (`npm run fetch-buildings` regenerates it; never fetch PASDA at runtime). Buildings are keyed by PSU building number `num`; the DB stores only that.
- **Backend:** Supabase: Postgres + RLS, Realtime (postgres_changes, presence), Storage (`drop-hints` bucket).
- **Auth:** Auth0 via Supabase third-party auth. Supabase verifies the Auth0 **ID token**, which an Auth0 Action stamps with `role: authenticated` and `app_role`. When `VITE_AUTH0_*` is empty, the app falls back to Supabase anonymous sign-in plus an "enter your name" screen. Both give RLS a JWT `sub`, so policies are identical.
- **Deploy:** Vercel, Root Directory `web`. `web/vercel.json` holds the SPA rewrite. Secret-key code goes in `web/api/`: `search-events.ts` (Gemini only), `sync-events.ts` (Discover + Gemini + service-role key, called by pg_cron), and `club-insights.ts` (service-role key + Gemini), sharing `_shared.ts` (auth as the calling player, Gemini with retry and model fallback inside a 25 s budget, `GeminiError` kinds busy/unavailable/garbled; the `_` keeps Vercel from serving it), `_discover.ts`, and `_clubInsights.ts`. `vercel.json` gives `api/*.ts` a 60 s `maxDuration` and bundles `public/data/buildings.geojson` (read from disk by `_discover.ts`). `npm run dev` serves `web/api/*.ts` too, via the `apiRoutes` plugin in `vite.config.ts`.

## Layout

```
web/
  public/data/         buildings.geojson (generated, committed)
  scripts/             fetch-buildings.mjs (PASDA → simplified GeoJSON, mapshaper), Discover import/sync/seed
  api/                 search-events, sync-events, club-insights (+ _shared, _discover, _keywordSearch, _clubInsights)
  tests/               unit/, sql/ (PGlite), api/ (handlers vs. the mock), mock/ (fake Supabase), e2e/ (headless Edge on a production build)
  src/
    App.tsx            routes
    pages/             Map, Clubs (/clubs), ClubDashboard (/clubs/:organization), Profile, Admin (/admin),
                       Claim (/claim/:dropId?key=), EventCheckin (/checkin/:eventId?key=), JoinScreen
    session/           SessionProvider (Auth0 or anonymous), PresenceProvider (the only GPS watcher; `subscribe` for every fix),
                       TrailProvider (my trail + others' tails), DiscoveryProvider (fog-of-war areas)
    components/        CampusMap (MapLibre wrapper), DropSheet, EventSheet, EventReminders, SearchSheet, MapKeySheet, MeetupSheet,
                       PlayerSprite, WalkLayers (fog + trails), BuildingPicker, DropQrList, OrganizerRequests, CheckInResult, BottomNav
    map/               basemap.ts (declutter + landmarks), geometry.ts (geodesic circles, heights), hexgrid.ts (fog areas), worker.ts
    lib/               supabase.ts, api.ts (all DB calls), hooks.ts, geo.ts, buildings.ts, campus.ts, interests.ts, eventTime.ts, database.types.ts
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
7. `20261024060000_photo_hunt.sql`: hunt columns, hidden spot in `drop_secrets`, `claims.points`, photo hunt functions, `current_player_id`.
8. `20261025000000_discovered_areas.sql`: fog-of-war `discovered_areas (player_id, hex_id)` (own rows only) and `discover_area()`.
9. `20261025010000_meetups.sql`: `meetup` drop type, `create_meetup()` (any player), `close_drop()` (admins any drop, players their own meetup), `claim_drop` refuses meetups.
10. `20261025020000_quick_draw.sql`: `drops.game`, `game_results`, Quick Draw.
11. `20261025030000_landmark.sql`: Point to the Landmark, `campus_landmarks`.
12. `20261025030000_needle_rain.sql`: Needle Rain. Applied after the landmark file (filename order).
13. `20261025040000_event_search.sql`: `search_quota` (a per-player counter, no query text) and `use_search_quota()` (10 searches per 10 minutes) for AI event search.
14. `20261028000000_discover_sync.sql`: `discover_events` (players read), `discover_locations` (Gemini placement cache, service only), service-only `sync_discover_events()` (upsert, cancel on complete fetch, seeded drops follow their event).
15. `20261028010000_event_rsvps.sql`: `event_rsvps` (own rows only), `event_going()` (counts, never who), `set_going()` (on/off, refuses ended or cancelled events).
16. `20261028020000_player_profiles.sql`: private `player_profiles` (major, interests checked against `INTERESTS`), `discover_events.benefits`, and `sync_discover_events()` replaced to store benefits.
17. `20261029000000_remove_games_and_points.sql`: closes live games and hunts, reopens live check-ins, drops every game/hunt function and `player_scores`, a trigger refuses new `minigame`/`photo_hunt` drops, and `claim_drop` becomes a once-per-player check-in that leaves the drop open. Tables and old rows stay.
18. `20261029010000_clubs.sql`: `event_checkins` (own rows only), `event_secrets` (door QR codes, function-only), `club_organizers`, `organizer_requests`, `runs_club`, `request_organizer`, `decide_organizer_request`, `event_checkin_code`, `check_in_event`, `club_stats` (counts only), a `claims` trigger linking seeded-drop check-ins to their event, and `sync_discover_events()` replaced to keep events with RSVPs or check-ins.

Migrations 4, 7, and 10–12 built features that 17 removed; they still have to run, in order. Every schema change is a new migration. Update `docs/SCHEMA.md` and `web/src/lib/database.types.ts` (hand-written) in the same commit.

## Rules (don't break these)

- Authorization lives in RLS and `security definer` functions. Clients write only through functions; direct writes to `claims`, `event_rsvps`, `event_checkins`, `club_organizers`, and `organizer_requests` are blocked. The anon key is public.
- `claim_drop` checks in at `checkin` drops only, once per player, and never closes the drop. It refuses meetups (anyone can post one) and old game/hunt rows. Players post meetups only through `create_meetup` (drops inserts stay admin-only), and clearing goes through `close_drop`, never a delete (claims cascade on delete and would erase attendance).
- Organizers and admins see **counts only**. `club_stats`, `event_going`, and `/api/club-insights` must never return player ids or names, and Gemini must never see anything about a player (only aggregated counts and the club's own public events).
- Only admins make organizers (`decide_organizer_request`). Organizer-only functions check `runs_club()`, and `/api/club-insights` calls `club_stats` **as the caller** before it reads anything with the service key.
- The GPS radius exists only in SQL `claim_radius_m()`; the client reads it (`useClaimRadius`). Never hard-code 60. `distanceM` (TS) must stay identical to SQL `distance_m` (same haversine, R = 6,371 km). The 30-minute early check-in window lives in `check_in_event` and is mirrored by `CHECK_IN_EARLY_MS` in `lib/eventTime.ts` (it only decides when the button shows).
- QR codes live only in `drop_secrets` (admin-read) and `event_secrets` (through `event_checkin_code`, organizers only). Never put them in `drops` or `discover_events`.
- Live locations go only over the Presence channel `campus`; never store them. Read position from `usePresence()` and never start a second geolocation watcher. Code that must see every fix (trails, discovery) uses `usePresence().subscribe`. My trail stays in `localStorage`; `discovered_areas` holds only (player, hex), never times or coordinates.
- Components call Supabase only through `lib/api.ts`. Live data uses `useLiveQuery`; call `refresh()` after your own writes (venue Wi-Fi drops Realtime). RSVPs and event check-ins notify `subscribeToMyActivity`, so reminders and cards update at once.
- Player names are user input. React escapes them; anything put into raw HTML must be escaped.
- Phones first: `100dvh`, safe-area insets, 48 px touch targets.

## Fragile: read before touching

- **Gemini time budget and model order.** `askGeminiJson` tries `gemini-flash-lite-latest`, then `gemini-flash-latest`, then lite again, each for at most 12 s, and gives up after `GEMINI_BUDGET_MS` (25 s) in all, counting that as busy. Lite goes first because it answers search's ~300-event prompt in 1–2 s, while `gemini-flash-latest` took 13 s to over 55 s (Oct 2026). Vercel stops a function at 60 s and the player then gets no answer at all ("The event finder took too long"), so keep every Gemini call well under the limit and leave room for the fallback. Measure a real search before reordering.
- **`web/tsconfig.json`'s `rewriteRelativeImportExtensions` (do not remove).** `web/api/*.ts` import each other as `./_shared.ts` (Node runs `.ts` directly for scripts and tests). Vercel's `@vercel/node` compiles each file to `.js` using the options in the `tsconfig.json` nearest the function, which is `web/tsconfig.json` (not `tsconfig.node.json`). Without this option the built code still imports `./_shared.ts`, and every `/api` function crashes on load with `FUNCTION_INVOCATION_FAILED` while working fine locally.
- **MapLibre worker (do not remove).** MapLibre 6 loads its worker from a separate file, and `src/map/worker.ts` registers it (`setWorkerUrl` with a Vite `?worker&url` import). Without it, production shows a blank map ("Worker failed to load"). `npm run test:e2e` builds for production and fails if this breaks. `optimizeDeps.exclude: ['maplibre-gl']` in `vite.config.ts` is extra insurance for dev; MapLibre otherwise depends on Vite's dep cache being fresh.
- After installing or removing deps while `npm run dev` runs, Vite's dep cache can go stale (504 "Outdated Optimize Dep", or imports of deleted packages) and the page goes blank. Stop the server, `rm -rf web/node_modules/.vite`, and restart.
- **Vaul 1.1.2 + controlled `open`:** Vaul doesn't pass `modal={false}` to Radix, so opening the sheet from code leaves `pointer-events: none` on `<body>` (map untappable). `DropSheet` resets it; keep it (`components/useNonModalSheet.ts`, used by every non-modal sheet).
- **Sprites:** `PlayerSprite` FLIPs from the old screen position in a `useLayoutEffect` (react-map-gl moves the marker during render). Don't put CSS `filter`s on the breathing element; a drop-shadow there cost ~25% fps. My own sprite sits on top of any pin at my position, so a tap there opens my name tag.
- **Fog layer order:** `WalkLayers` adds the fog with `beforeId: 'buildings-active-glow'` so it sits under the glow, check-in circles, drops, trails, and sprites. Layers mount in JSX order, so keep `<WalkLayers />` first among `MapPage`'s map children, and don't mount map sources conditionally (a late mount lands on top). Hex ids come only from the constants in `hexgrid.ts`; changing the edge or origin orphans every stored discovery.
- `map.loaded()` stays false forever because the highlight pulse keeps a paint transition running. Use `isStyleLoaded()` plus rendered features instead.
- react-map-gl's `Map` takes no `className`; `CampusMap` wraps it in a sized `div`. `maxBounds` must be a flat `[w, s, e, n]`.
- `campusBounds` deliberately ignores far-off PASDA property (Ag Progress Days, the airport) by keeping buildings within 2.5 km of the median building, then pads by 1.6 km.
- Building names in PASDA are formal ("Hetzel Union Building (Ralph Dorn)"). `BUILDING_NICKNAMES` in `lib/campus.ts` makes HUB, BJC, and IST searchable, and `LANDMARKS` in `map/basemap.ts` labels the map.
- **Club suggestions are in State College time.** `_clubInsights.ts` converts with `Intl` (`America/New_York`), so daylight saving is handled; never use the server's local time (Vercel runs in UTC).
- **`BottomNav` tab count** is a CSS variable (`--tabs`): organizers and admins get Map / Clubs / Profile, everyone else Map / Profile.

## Tests (`web/tests/`)

Run `npm test` in `web/` (unit + SQL + API + e2e, a few minutes), plus `npm run lint` and `npm run build`, before every commit.

- **`npm run test:unit`:** `tests/unit/interests.test.mjs` checks "For you" matching (Discover categories, themes, benefits, title words, major stems, hints, ranking) and that `INTERESTS` matches the migration's check constraint. `tests/unit/club-insights.test.mjs` checks `_clubInsights.ts`: interested counts (RSVPs plus matches, each player once), local time slots across daylight saving, and the no-AI suggestions (club history first, crowded slots lose, no history falls back to campus numbers).
- **`npm run test:sql`:** runs migrations in PGlite (in-process Postgres) and checks behavior through real RLS. `tests/sql/harness.mjs` stubs Supabase (`anon`/`authenticated` roles, `auth.jwt()` from `request.jwt.claims`, storage tables, the `supabase_realtime` publication, and Supabase's default table grants via `alter default privileges`). It also provides `actor(db)(sub, claims, sql)` to act as a user and `superuser(db)` for setup and time travel.
  - `current-schema.test.mjs`: all migrations applied. Joining, RLS, drops, checking in (the 59 m/61 m boundary, once per player, the drop stays open), QR codes, and that games, hunts and scores are gone (functions dropped, new game drops refused).
  - `clubs.test.mjs`: organizer requests (idempotent, 5 pending max, admin-only approval), RLS on organizers and requests, door QR codes (organizers only, stable), every `check_in_event` refusal and the 30-minute window, seeded-drop check-ins, `club_stats` numbers and access (counts only), and pruning keeping history.
  - `meetups.test.mjs`: posting rules (length, on campus, one live meetup, 5/hour, 15–180 min), nothing to check in to by GPS or QR, and `close_drop` permissions (admins any drop, players only their own meetup; check-ins survive).
  - `event-search.test.mjs`: the search rate limit (10 per 10 minutes, per player, resets), counters unreadable by players, no query column.
  - `player-profiles.test.mjs`: own-row-only read/insert/update, no deletes, interest and major checks, cascade, and that the sync stores benefits and stays service-only.
  - `event-rsvps.test.mjs`: going on/off and counts, `event_going` never exposes who, own-rows-only reads, no direct writes, refusals (ended, cancelled, unknown, not joined), cascades.
  - `discover-sync.test.mjs`: `sync_discover_events` is service-only, players read but never write events, the location cache is server-only, truncated fetches cancel nothing, seeded drops reschedule and close with their event (check-ins survive, closed stays closed), ended events aren't "cancelled", 30-day pruning.
  - `discovery.test.mjs`: `discovered_areas` RLS (own rows only, no edits/deletes, anon blocked), duplicate-ignoring `discover_area`, hex id format, cascade on player delete.
  - `migration-paths.test.mjs`: builds data under an older schema, upgrades, and checks nothing is lost (teams to individuals; capture removal; per-claim points; game kinds; the games-and-points removal closing games and hunts, reopening live check-ins, and keeping every claim). Add a block here for any migration that rewrites data.
  - `distance-parity.test.mjs`: TS `distanceM` against SQL `distance_m` near the radius.
- **`npm run test:api`:** `search-events.test.mjs` runs the real `web/api/search-events.ts` against the mock with Gemini faked and the clock pinned to the snapshot: auth, query limits, id validation (unknown, ended, duplicate), the 6-result cap, empty and garbled answers, busy Gemini, the rate limit, and that no query is logged. `sync-events.test.mjs` runs the real `web/api/sync-events.ts` against the mock with Discover and Gemini faked: the shared secret, which locations reach Gemini (never online, matched, or other-campus ones), invalid building numbers, the cache, a Gemini outage, the 5-page truncation, a Discover outage, and search reading the synced events. `club-insights.test.mjs` runs the real `web/api/club-insights.ts`: auth and organizer-only access, interested counts, Gemini's picks checked (bad weekday, hour, duplicate day, unknown building), the numbers-only fallback (402, garbled, no key), and that Gemini never sees a player. `gemini-timeout.test.mjs` shortens the budget to 3 s and each attempt to 1 s, and checks the model order, that a hanging model (or a body that never finishes), a busy one, and a retired one each give way to the next, that a bad key stops at once, that everything ends inside the budget, and that search answers with keyword matches when no model does.
- **`npm run test:e2e`:** starts `tests/mock/supabase.mjs`, makes a **production build** pointed at it (`VITE_E2E=1`, output in `node_modules/.cache/e2e-dist`), serves it with `vite preview` on 5199, and drives headless **Microsoft Edge** through `playwright-core` (`E2E_BROWSER_CHANNEL=chrome` to switch) at 375×812, DPR 2, touch, with granted geolocation. It covers five scenarios:
  - **Map:** camera, layers, highlight, checking in within range (and not twice; the drop stays), bounds, recenter, the tabs (no leaderboard), admin tap-to-place of a check-in.
  - **AI event search:** example prompts, results (reason, online event, a drop you can check in at), flying to and lighting the building with its card, a drop result opening the drop's card, "Nothing matched", and a busy error. The mock's `/__search-events` stands in for the API via `page.route`.
  - **Campus events:** seeds events through the mock's `sync_discover_events`, then checks one pin per building in its event type's color (none for online, seeded-drop, over-a-week, or multi-day events), the building tint, that tapping a pin zooms in and opens the soonest event with "Also here", the going count (2 bots RSVP'd) and the I'm going toggle on and off, the "Get picks for you" nudge into Profile, saving a major and interests, "For you" ranking with reasons, the card's For you tag, the search sheet's "Coming up on campus" list, and the map key.
  - **Clubs:** a live event's card offers GPS check-in at its building; RSVPing shows the top-left reminder, which goes away after checking in; asking to run the club; approving it on /admin; the Clubs tab and the dashboard (second-visit rate, the four tiles, ideas labeled as from the numbers, upcoming and past events, no names); the door QR code checking a second phone in, once, and refusing a wrong code. The mock's `/__club-insights` stands in for the API.
  - **Meetups (runs last):** posts a meetup from the "+ Meetup" sheet, checks its card (nothing to check in to, no circle), ends it with the two-tap confirm, then clears the HUB check-in as an admin.

  Screenshots land in `tests/e2e/screenshots/` (gitignored). It also prints frame rate (software WebGL, so a phone GPU will differ).
- **`npm run mock`:** runs the mock alone on :54321 for manual testing with `VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=mock npm run dev`. The mock mirrors the SQL rules (radius, QR codes, once-per-player check-ins, event check-ins, organizers, club stats) but isn't authoritative; `tests/sql` is. Everyone who joins is an admin. It has **no Realtime**, which is why the app's `refresh()`/poll fallbacks matter. `GET /__state` dumps its data, and in-process tests reach it as `server.db`.
- The map handle `window.__walkpsuMap` exists only in dev or a `VITE_E2E` build; normal production builds strip it. The in-app browser pane often stops firing `requestAnimationFrame`, so MapLibre never renders there. Use the e2e suite or a real browser instead.
- Changing the schema or an RPC means updating the mock too, or the e2e run breaks.

## Windows environment gotchas

- The shell is Git Bash on Windows. Long heredocs containing JSX, quotes, or backslashes sometimes fail or get mangled ("unexpected EOF while looking for matching `'`", regex `\s` turning into `s`). Write the script to a file with the Write tool, or use Write/Edit directly.
- Source files have CRLF line endings in the working tree. Scripts that match multi-line strings must normalize `\r\n` first.
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
npm test                 # unit + sql + api + e2e (needs Microsoft Edge, or E2E_BROWSER_CHANNEL=chrome)
npm run mock             # mock Supabase on :54321 for manual UI testing
```

Copy `web/.env.example` to `web/.env`. `VITE_*` vars ship to the browser; secrets must not use that prefix. Never commit `.env`.
