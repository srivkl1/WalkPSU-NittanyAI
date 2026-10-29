-- Mini-games, photo hunts and points are gone. A drop is now a check-in (by GPS or its QR code) or a player's meetup,
-- and a check-in counts as attendance: everyone who comes checks in once, and the drop stays open for the next person.
--
-- Nothing is deleted. The game tables (games, game_players, game_results, campus_landmarks), the hunt columns and old
-- claims stay where they are, unread. Only the functions that ran games, hunts and scores go away.

-- Live game and hunt drops close the way close_drop() closes a drop: expired, never deleted (claims cascade on delete).
update drops set status = 'expired', expires_at = least(coalesce(expires_at, now()), now())
where type in ('minigame', 'photo_hunt') and status = 'active';

-- A check-in used to close on its first claim. Upcoming and live ones reopen so everyone can check in.
update drops set status = 'active'
where type = 'checkin' and status = 'claimed' and expires_at > now();

drop function if exists
  join_game, start_game, submit_shakes, submit_reaction, submit_heading, submit_dodges, submit_ghost, finish_game,
  get_game_state, game_sides, side_scores, minigame_settings, minigame_label, shake_off_settings, needle_rain_settings,
  quick_draw_signal_at, landmark_rounds, bearing_deg, angle_diff, create_photo_hunt, photo_hunt_check, claim_photo_hunt;

drop view if exists player_scores;

-- No new games or hunts, even by an admin writing to drops directly.
create function drops_only_checkins() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.type::text in ('minigame', 'photo_hunt') then
    raise exception 'Mini-games and photo hunts were removed. Drop a check-in instead';
  end if;
  return new;
end;
$$;

create trigger drops_only_checkins before insert or update of type on drops
for each row execute function drops_only_checkins();

-- Check in at a drop: GPS inside claim_radius_m(), or its QR code from anywhere. Once per player; the drop stays open.
create or replace function claim_drop(
  p_drop_id uuid,
  p_lat double precision default null,
  p_lng double precision default null,
  p_code text default null
)
returns claims language plpgsql security definer set search_path = public as $$
declare
  v_player players;
  v_drop drops;
  v_claim claims;
begin
  select * into v_player from players where auth_id = auth.jwt()->>'sub';
  if not found then
    raise exception 'Join before checking in';
  end if;

  select * into v_drop from drops where id = p_drop_id;
  if not found then
    raise exception 'Drop not found';
  end if;
  if v_drop.type = 'meetup' then
    raise exception 'Meetups are just for showing up, there''s nothing to check in to';
  end if;
  if v_drop.type <> 'checkin' then
    raise exception 'This drop is no longer available';
  end if;
  perform assert_drop_proof(v_drop, p_lat, p_lng, p_code);

  insert into claims (drop_id, player_id)
  values (p_drop_id, v_player.id)
  on conflict (drop_id, player_id) do nothing
  returning * into v_claim;
  if v_claim.id is null then
    raise exception 'You already checked in here';
  end if;
  return v_claim;
end;
$$;
