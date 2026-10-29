-- WalkPSU's own RSVPs for campus events (discover_events): players tap "I'm going" on an event's card. Everyone sees
-- how many are going; nobody sees who. Discover's own RSVP numbers are deliberately not used.

create table event_rsvps (
  event_id text not null references discover_events (id) on delete cascade,
  player_id uuid not null references players (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create index event_rsvps_player on event_rsvps (player_id);

-- A player reads only their own RSVPs. Writes go through set_going(); counts through event_going().
alter table event_rsvps enable row level security;
create policy "players read own rsvps" on event_rsvps for select to authenticated using (player_id = current_player_id());
revoke insert, update, delete on event_rsvps from anon, authenticated;
revoke select on event_rsvps from anon;

-- Each event's going count, and whether the caller is going. Counts only: never who.
create function event_going(p_event_ids text[])
returns table (event_id text, going integer, me boolean)
language sql stable security definer set search_path = public as $$
  select e.id, count(r.player_id)::integer, coalesce(bool_or(r.player_id = current_player_id()), false)
  from discover_events e
  left join event_rsvps r on r.event_id = e.id
  where e.id = any (p_event_ids[1:100])
  group by e.id;
$$;

-- The caller's RSVP on or off. Returns the event's new going count. Only for an event that hasn't ended or been
-- cancelled; un-RSVPing always works.
create function set_going(p_event_id text, p_going boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_player uuid := current_player_id();
  v_event discover_events;
  v_going integer;
begin
  if v_player is null then
    raise exception 'Join the game before RSVPing';
  end if;
  select * into v_event from discover_events where id = p_event_id;
  if not found then
    raise exception 'Event not found';
  end if;
  if p_going then
    if v_event.cancelled then
      raise exception 'This event was cancelled';
    end if;
    if v_event.ends_at <= now() then
      raise exception 'This event is over';
    end if;
    insert into event_rsvps (event_id, player_id) values (p_event_id, v_player) on conflict do nothing;
  else
    delete from event_rsvps where event_id = p_event_id and player_id = v_player;
  end if;
  select count(*)::integer into v_going from event_rsvps where event_id = p_event_id;
  return v_going;
end;
$$;

revoke execute on function event_going from public, anon;
revoke execute on function set_going from public, anon;
grant execute on function event_going to authenticated;
grant execute on function set_going to authenticated;
