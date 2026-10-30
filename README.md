# WalkPSU

A mobile-first web app, built at HackPSU, that puts Penn State University Park's campus life on a live map. Students
find events worth walking to and check in when they get there. Clubs see who's interested, who came, and who came back.

## What you can do

- **See what's on.** Every [Penn State Discover](https://discover.psu.edu/events) event this week gets a pin at its
  building, refreshed every 30 minutes. Tap one to see the details, how many are going, and other events there.
- **RSVP.** Tap "I'm going". Everyone sees how many are going, never who.
- **Get picks and reminders.** Save your major and interests in Profile to get "For you" picks. When an event you're
  going to (or one of your picks) is about to start, a reminder appears at the top left of the map.
- **Check in.** At an event, check in by GPS at its building or by scanning the club's QR code at the door. Admins can
  also drop check-ins anywhere on the map, each with its own QR code for indoors.
- **Run a club.** Open one of your club's events and tap "Run this club?". Once an admin approves, the Clubs tab shows
  your dashboard: the second-visit rate (how many people came back for another event), who's interested, RSVP'd,
  and checked in (counts only, never names), a door QR code for each event, and AI suggestions for when and where to
  hold the next one.
- **Find events with AI.** Tap "Find events you'd like…" on the map and describe what you're into. Gemini picks
  matching events and live drops, with a reason for each. Searches are never stored.
- **Meetups.** Pin "volleyball here right now" at your spot for others to join.
- **Walk.** Your trail fades behind you, nearby players show up live (opt-in), and walking clears a fog of war over
  campus.

Live locations are never stored.

## Run it

Everything lives in `web/` and needs Node 24.

**With no backend (a mock Supabase with bots), for trying the UI:**

```bash
cd web && npm install && npm run mock
```

Then, in a second terminal:

```bash
cd web && VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=mock npm run dev
```

Open http://localhost:5173 and enter a name. In the mock, everyone is an admin.

**With a real Supabase project:** copy `web/.env.example` to `web/.env`, then follow [docs/SETUP.md](docs/SETUP.md)
(migrations, keys, optional Auth0 login, Vercel deploy). Without Auth0, players sign in by entering a name.

GPS needs HTTPS on a real phone, so test checking in on the Vercel deploy.

## Tests

From `web/`:

```bash
npm test
```

That runs unit tests ("For you" matching and the club dashboard's numbers), the SQL tests (every migration in
in-process Postgres, through real row-level security), the API tests (event search, the Discover sync, and club
insights, with Gemini faked), and end-to-end tests in headless Microsoft Edge against a production build. Also run
`npm run lint` and `npm run build` before committing.

## Stack

- React 19, Vite and TypeScript
- MapLibre GL on OpenFreeMap tiles, with 958 campus building footprints from PASDA
- Supabase: Postgres with row-level security, Realtime, Storage
- Auth0 login, with an anonymous name-only fallback
- Gemini for event search, placing events at buildings, and club suggestions
- Vercel hosting

## Docs

- [docs/SETUP.md](docs/SETUP.md): setting up Supabase, Auth0, Vercel, and the campus-event sync
- [docs/SCHEMA.md](docs/SCHEMA.md): tables, functions, and rules on the server
- [CLAUDE.md](CLAUDE.md): architecture, project rules, and the fragile parts, for anyone (or any agent) changing the
  code
