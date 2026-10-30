-- Clubs: event check-ins, organizers, and each club's numbers for its dashboard.
--
-- A club is a Penn State Discover organization (discover_events.organization). A player asks to run one and an admin
-- approves it. Organizers see counts and rates only, never who RSVP'd or checked in.

-- Who came to a campus event: by its QR code at the door, by GPS at its building, or by checking in at a drop seeded
-- from it. Once per player per event.
create table event_checkins (
  event_id text not null references discover_events (id) on delete cascade,
  player_id uuid not null references players (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create index event_checkins_player on event_checkins (player_id);

alter table event_checkins enable row level security;
create policy "players read own checkins" on event_checkins for select to authenticated using (player_id = current_player_id());
revoke insert, update, delete on event_checkins from anon, authenticated;
revoke select on event_checkins from anon;

-- Each event's door QR code, made the first time its organizer opens it. Read only through event_checkin_code().
create table event_secrets (
  event_id text primary key references discover_events (id) on delete cascade,
  code text not null default replace(gen_random_uuid()::text, '-', '')
);

alter table event_secrets enable row level security;
revoke all on event_secrets from anon, authenticated;

create table club_organizers (
  organization text not null,
  player_id uuid not null references players (id) on delete cascade,
  approved_at timestamptz not null default now(),
  primary key (organization, player_id)
);

create index club_organizers_player on club_organizers (player_id);

create table organizer_requests (
  id uuid primary key default gen_random_uuid(),
  organization text not null,
  player_id uuid not null references players (id) on delete cascade,
  note text check (char_length(note) <= 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create unique index organizer_requests_one_pending on organizer_requests (organization, player_id) where status = 'pending';

-- A player sees their own organizer rows and requests; admins see all of them, to approve. Writes go through functions.
alter table club_organizers enable row level security;
create policy "own or admin" on club_organizers for select to authenticated using (player_id = current_player_id() or is_admin());
revoke insert, update, delete on club_organizers from anon, authenticated;
revoke select on club_organizers from anon;

alter table organizer_requests enable row level security;
create policy "own or admin" on organizer_requests for select to authenticated using (player_id = current_player_id() or is_admin());
revoke insert, update, delete on organizer_requests from anon, authenticated;
revoke select on organizer_requests from anon;

-- Admins run every club's dashboard; organizers run their own.
create function runs_club(p_organization text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (select 1 from club_organizers where organization = p_organization and player_id = current_player_id());
$$;

-- "I run this club." Asking again while a request waits returns that request.
create function request_organizer(p_organization text, p_note text default null)
returns organizer_requests language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := current_player_id();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_request organizer_requests;
begin
  if v_player is null then
    raise exception 'Join before asking to run a club';
  end if;
  if not exists (select 1 from discover_events where organization = p_organization) then
    raise exception 'Club not found';
  end if;
  if exists (select 1 from club_organizers where organization = p_organization and player_id = v_player) then
    raise exception 'You already run this club';
  end if;
  select * into v_request from organizer_requests where organization = p_organization and player_id = v_player and status = 'pending';
  if found then
    return v_request;
  end if;
  if (select count(*) from organizer_requests where player_id = v_player and status = 'pending') >= 5 then
    raise exception 'You have 5 requests waiting. Wait for an admin to answer them';
  end if;
  insert into organizer_requests (organization, player_id, note) values (p_organization, v_player, v_note) returning * into v_request;
  return v_request;
end;
$$;

-- Admins approve (the player becomes an organizer) or decline a waiting request.
create function decide_organizer_request(p_request_id uuid, p_approve boolean)
returns organizer_requests language plpgsql security definer set search_path = public as $$
declare
  v_request organizer_requests;
begin
  if not is_admin() then
    raise exception 'Only admins can approve organizers';
  end if;
  update organizer_requests set status = case when p_approve then 'approved' else 'declined' end, decided_at = now()
  where id = p_request_id and status = 'pending'
  returning * into v_request;
  if not found then
    raise exception 'That request was already answered';
  end if;
  if p_approve then
    insert into club_organizers (organization, player_id) values (v_request.organization, v_request.player_id) on conflict do nothing;
  end if;
  return v_request;
end;
$$;

-- An event's door QR code, for its club's organizers (and admins).
create function event_checkin_code(p_event_id text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_event discover_events;
  v_code text;
begin
  select * into v_event from discover_events where id = p_event_id;
  if not found then
    raise exception 'Event not found';
  end if;
  if not runs_club(v_event.organization) then
    raise exception 'Only this club''s organizers can show its check-in code';
  end if;
  insert into event_secrets (event_id) values (p_event_id) on conflict do nothing;
  select code into v_code from event_secrets where event_id = p_event_id;
  return v_code;
end;
$$;

-- Check in to an event: its QR code, or GPS inside claim_radius_m() of its building. Opens 30 minutes before the start
-- and closes at the end. True on the first check-in, false if already checked in.
create function check_in_event(p_event_id text, p_lat double precision default null, p_lng double precision default null, p_code text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := current_player_id();
  v_event discover_events;
  v_new integer;
begin
  if v_player is null then
    raise exception 'Join before checking in';
  end if;
  select * into v_event from discover_events where id = p_event_id;
  if not found then
    raise exception 'Event not found';
  end if;
  if v_event.cancelled then
    raise exception 'This event was cancelled';
  end if;
  if now() < v_event.starts_at - interval '30 minutes' then
    raise exception 'Check-in opens 30 minutes before the event';
  end if;
  if now() > v_event.ends_at then
    raise exception 'This event is over';
  end if;
  if p_code is not null then
    if not exists (select 1 from event_secrets where event_id = p_event_id and code = p_code) then
      raise exception 'That QR code doesn''t match this event';
    end if;
  elsif v_event.building is null then
    raise exception 'Scan the event''s QR code to check in';
  elsif p_lat is null or p_lng is null then
    raise exception 'Location unavailable. Scan the event''s QR code instead';
  elsif distance_m(p_lat, p_lng, (v_event.building->>'lat')::double precision, (v_event.building->>'lng')::double precision) > claim_radius_m() then
    raise exception 'Get closer to the building, or scan the event''s QR code';
  end if;
  insert into event_checkins (event_id, player_id) values (p_event_id, v_player) on conflict do nothing;
  get diagnostics v_new = row_count;
  return v_new = 1;
end;
$$;

-- Checking in at a drop seeded from a campus event checks you in to that event too.
create function claims_check_in_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into event_checkins (event_id, player_id)
  select e.id, new.player_id
  from drops d join discover_events e on 'discover:' || e.id = d.source_id
  where d.id = new.drop_id
  on conflict do nothing;
  return new;
end;
$$;

create trigger claims_check_in_event after insert on claims for each row execute function claims_check_in_event();

-- A club's dashboard numbers, counts only. Events from the last 90 days and every upcoming one, newest first, each with
-- its RSVPs and check-ins. "Returning" players checked in to two or more of the club's events.
create function club_stats(p_organization text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_events jsonb;
  v_attendees integer;
  v_returning integer;
begin
  if not runs_club(p_organization) then
    raise exception 'Only this club''s organizers can see its dashboard';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'title', e.title, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'cancelled', e.cancelled,
      'location', e.location, 'building', e.building,
      'going', (select count(*) from event_rsvps r where r.event_id = e.id),
      'checked_in', (select count(*) from event_checkins c where c.event_id = e.id)
    ) order by e.starts_at desc), '[]')
  into v_events
  from discover_events e
  where e.organization = p_organization and e.ends_at > now() - interval '90 days';

  select count(*), count(*) filter (where visits >= 2) into v_attendees, v_returning
  from (
    select c.player_id, count(distinct c.event_id) as visits
    from event_checkins c join discover_events e on e.id = c.event_id
    where e.organization = p_organization
    group by c.player_id
  ) per_player;

  return jsonb_build_object(
    'organization', p_organization,
    'events', v_events,
    'attendees', v_attendees,
    'returning', v_returning,
    'rsvps', (select count(*) from event_rsvps r join discover_events e on e.id = r.event_id where e.organization = p_organization),
    'checkins', (select count(*) from event_checkins c join discover_events e on e.id = c.event_id where e.organization = p_organization)
  );
end;
$$;

revoke execute on function runs_club, request_organizer, decide_organizer_request, event_checkin_code, check_in_event, club_stats from public, anon;
grant execute on function runs_club, request_organizer, decide_organizer_request, event_checkin_code, check_in_event, club_stats to authenticated;
revoke execute on function claims_check_in_event from public, anon, authenticated;

-- The sync keeps an event that anyone RSVP'd to or checked in to, so a club's history (and second-visit rate) survives
-- the 30-day pruning. Otherwise unchanged from 20261028020000_player_profiles.sql.
create or replace function sync_discover_events(p_events jsonb, p_complete boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_events integer;
  v_cancelled integer := 0;
  v_rescheduled integer;
  v_closed integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'p_events must be an array';
  end if;

  insert into discover_events as d (id, title, organization, theme, categories, benefits, starts_at, ends_at, location, building, cancelled, synced_at)
  select distinct on (e->>'id')
    e->>'id', e->>'title', e->>'organization', e->>'theme',
    array(select jsonb_array_elements_text(coalesce(e->'categories', '[]'))),
    array(select jsonb_array_elements_text(coalesce(e->'benefits', '[]'))),
    (e->>'starts_at')::timestamptz, (e->>'ends_at')::timestamptz, e->>'location',
    nullif(e->'building', 'null'::jsonb), false, now()
  from jsonb_array_elements(p_events) e
  order by e->>'id'
  on conflict (id) do update set
    title = excluded.title, organization = excluded.organization, theme = excluded.theme,
    categories = excluded.categories, benefits = excluded.benefits, starts_at = excluded.starts_at,
    ends_at = excluded.ends_at, location = excluded.location, building = excluded.building, cancelled = false,
    synced_at = now();
  get diagnostics v_events = row_count;

  if p_complete then
    update discover_events set cancelled = true, synced_at = now()
    where not cancelled and ends_at > now()
      and not exists (select 1 from jsonb_array_elements(p_events) e where e->>'id' = discover_events.id);
    get diagnostics v_cancelled = row_count;
  end if;

  update drops dr set starts_at = d.starts_at, expires_at = d.ends_at
  from discover_events d
  where dr.source_id = 'discover:' || d.id and dr.status = 'active' and not d.cancelled
    and (dr.starts_at is distinct from d.starts_at or dr.expires_at is distinct from d.ends_at);
  get diagnostics v_rescheduled = row_count;

  update drops dr set status = 'expired', expires_at = least(coalesce(dr.expires_at, now()), now())
  from discover_events d
  where dr.source_id = 'discover:' || d.id and dr.status = 'active' and d.cancelled;
  get diagnostics v_closed = row_count;

  delete from discover_events d
  where d.ends_at < now() - interval '30 days'
    and not exists (select 1 from event_rsvps r where r.event_id = d.id)
    and not exists (select 1 from event_checkins c where c.event_id = d.id);

  return jsonb_build_object('events', v_events, 'cancelled', v_cancelled, 'drops_rescheduled', v_rescheduled, 'drops_closed', v_closed);
end;
$$;
