-- PassSystem: remediation of Codex review 4 (docs/CODEX_REVIEW_4.md, R4-01, R4-03, R4-06).

-------------------------------------------------------------------------------
-- R4-01: an invite's role applies only while that invite is the latest one
-------------------------------------------------------------------------------
-- Every invite reserves a generation for the email address *before* Supabase
-- Auth issues its link (begin_invite). Setting the role afterwards
-- (set_pending_admin) only takes effect if no newer invite was reserved and no
-- demotion happened since; otherwise it returns 'stale' and changes nothing.
-- A pending promotion remembers its generation, and is honoured on acceptance
-- only if it is still current. Demotion (set_user_admin) advances the
-- generation, which voids every invite request still in flight.
--
-- Lock order, the same in every path: admin lock -> auth.users row ->
-- invite generation row -> profiles row. The acceptance trigger runs under the
-- auth.users row lock and only reads the generation row after the profile.
create table private.invite_generations (
  email text primary key,
  generation bigint not null,
  updated_at timestamptz not null default now()
);
revoke all on table private.invite_generations from public, anon, authenticated;

-- Promotions queued before this migration carry generation 0, which matches an
-- address that has no generation row yet, so they are still honoured.
alter table private.pending_admin_invites add column generation bigint not null default 0;

create function public.begin_invite(p_email text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.invite_generations as g (email, generation)
  values (lower(btrim(p_email)), 1)
  on conflict (email) do update set generation = g.generation + 1, updated_at = now()
  returning g.generation;
$$;
revoke all on function public.begin_invite(text) from public, anon, authenticated;
grant execute on function public.begin_invite(text) to service_role;

-- Returns 'queued', 'granted', 'cleared', 'unchanged' (as in 008), 'stale'
-- (a newer invite or a demotion superseded this one), or 'not_found'.
drop function if exists public.set_pending_admin(uuid, boolean, uuid);

create function public.set_pending_admin(
  p_user_id uuid,
  p_admin boolean,
  p_generation bigint,
  p_invited_by uuid default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_confirmed timestamptz;
  v_email text;
  v_current bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('passsystem:admins', 0));

  select u.email_confirmed_at, lower(u.email) into v_confirmed, v_email
  from auth.users u where u.id = p_user_id
  for update;
  if not found then
    return 'not_found';
  end if;

  select g.generation into v_current
  from private.invite_generations g where g.email = v_email
  for update;
  if v_current is null or p_generation is distinct from v_current then
    return 'stale';
  end if;

  if v_confirmed is not null then
    if p_admin then
      -- This invite was accepted before its role was saved: same intent.
      update public.profiles set is_admin = true where id = p_user_id;
      delete from private.pending_admin_invites where user_id = p_user_id;
      return 'granted';
    end if;
    return 'unchanged';
  end if;

  if p_admin then
    insert into private.pending_admin_invites (user_id, invited_by, generation)
    values (p_user_id, p_invited_by, p_generation)
    on conflict (user_id) do update
      set invited_by = excluded.invited_by, generation = excluded.generation, created_at = now();
    return 'queued';
  end if;

  delete from private.pending_admin_invites where user_id = p_user_id;
  return 'cleared';
end;
$$;
revoke all on function public.set_pending_admin(uuid, boolean, bigint, uuid) from public, anon, authenticated;
grant execute on function public.set_pending_admin(uuid, boolean, bigint, uuid) to service_role;

create or replace function private.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending bigint;
begin
  insert into public.profiles (id, email, display_name, confirmed_at)
  values (
    new.id,
    lower(new.email),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.email_confirmed_at
  )
  on conflict (id) do update set email = excluded.email, confirmed_at = excluded.confirmed_at;

  -- Only on the transition to confirmed (invite accepted), and only once, and
  -- only if the promotion belongs to the latest invite.
  if tg_op = 'UPDATE' and old.email_confirmed_at is null and new.email_confirmed_at is not null then
    delete from private.pending_admin_invites where user_id = new.id
    returning generation into v_pending;
    if found and v_pending = coalesce(
      (select g.generation from private.invite_generations g where g.email = lower(new.email) for share), 0
    ) then
      update public.profiles set is_admin = true where id = new.id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.handle_auth_user_change() from public, anon, authenticated;

create or replace function public.set_user_admin(p_user_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  -- One admin change at a time across the whole system.
  perform pg_advisory_xact_lock(hashtextextended('passsystem:admins', 0));

  if not private.is_admin() then
    raise exception 'Not authorized' using errcode = '42501', hint = 'admin_required';
  end if;
  if not p_is_admin and p_user_id = auth.uid() then
    raise exception 'You cannot remove your own administrator rights' using errcode = 'P0001', hint = 'self_demotion';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002', hint = 'user_not_found';
  end if;

  if p_is_admin and v_target.confirmed_at is null then
    raise exception 'This person has not accepted their invite yet' using errcode = 'P0001', hint = 'user_not_confirmed';
  end if;

  if not p_is_admin and not exists (
    select 1 from public.profiles p where p.is_admin and p.id <> p_user_id
  ) then
    raise exception 'At least one administrator must remain' using errcode = 'P0001', hint = 'last_admin';
  end if;

  update public.profiles set is_admin = p_is_admin where id = p_user_id;
  if not found then
    -- Deleted concurrently.
    raise exception 'User not found' using errcode = 'P0002', hint = 'user_not_found';
  end if;
  if not p_is_admin then
    delete from private.pending_admin_invites where user_id = p_user_id;
    -- Void every invite request for this person that is still in flight.
    insert into private.invite_generations as g (email, generation)
    values (v_target.email, 1)
    on conflict (email) do update set generation = g.generation + 1, updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-------------------------------------------------------------------------------
-- R4-03: deleting an event's creator clears events.created_by
-------------------------------------------------------------------------------
-- validate_event restored created_by on every UPDATE, including the one the
-- ON DELETE SET NULL action issues, which left the deleted user's id behind.
-- It now only refuses to *change* the creator; clearing it is allowed (only
-- that foreign-key action does it: authenticated users cannot write the column).
create or replace function private.validate_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  new.location := nullif(btrim(new.location), '');
  new.description := nullif(btrim(new.description), '');
  -- Raises invalid_parameter_value for unknown IANA zones.
  perform now() at time zone new.timezone;
  if tg_op = 'UPDATE' then
    if new.created_by is not null then
      new.created_by := old.created_by;
    end if;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

-------------------------------------------------------------------------------
-- R4-06: 003-era retries match names that were stored without NFC
-------------------------------------------------------------------------------
create or replace function public.register_for_event(
  p_slug text,
  p_first_name text,
  p_last_name text,
  p_email text default null,
  p_request_id uuid default null,
  p_website text default null,
  p_phone text default null,
  p_accept_terms boolean default false,
  p_terms_version text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fp text := private.client_fingerprint();
  v_event public.events;
  v_state text;
  v_first text;
  v_last text;
  v_email text;
  v_phone text;
  v_token text;
  v_request_hash bytea;
  v_hash_004 bytea;
  v_hash_003 bytea;
  v_terms_hash bytea;
  v_reg public.registrations;
  v_taken integer;
begin
  if not private.rate_limit_hit('reg:ip:m:' || v_fp, private.setting('register_per_ip_per_minute', 30), 60)
     or not private.rate_limit_hit('reg:ip:h:' || v_fp, private.setting('register_per_ip_per_hour', 400), 3600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  if p_website is not null and btrim(p_website) <> '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'field', 'form');
  end if;

  v_first := private.clean_name(p_first_name, 100);
  if v_first is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'field', 'first_name');
  end if;
  v_last := private.clean_name(p_last_name, 100);
  if v_last is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'field', 'last_name');
  end if;

  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  if v_email is not null and (
    char_length(v_email) > 254
    or v_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'field', 'email');
  end if;

  if p_phone is not null and p_phone !~ '^[[:space:]]*$' then
    v_phone := private.clean_phone(p_phone);
    if v_phone is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_input', 'field', 'phone');
    end if;
  end if;

  select * into v_event from public.events e where e.slug = lower(btrim(p_slug));
  if not found or v_event.status in ('draft', 'archived') then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  if not private.rate_limit_hit('reg:event:' || v_event.id::text, private.setting('register_per_event_per_minute', 600), 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Serializes registrations (capacity, replay) for this event, then orders
  -- this registration against event edits through the shared row lock.
  perform private.lock_event_capacity(v_event.id);
  select * into v_event from public.events e where e.id = v_event.id for share;
  if not found or v_event.status in ('draft', 'archived') then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  if p_request_id is not null then
    v_request_hash := private.hash_secret(
      p_request_id::text || chr(31) || lower(v_first) || chr(31) || lower(v_last)
        || chr(31) || coalesce(v_email, '') || chr(31) || coalesce(v_phone, '')
    );
    -- Keys written before this format (migrations 004 and 003), for retries
    -- that straddle an upgrade. Neither format included a phone number.
    v_hash_004 := private.hash_secret(
      p_request_id::text || chr(31) || lower(v_first) || chr(31) || lower(v_last) || chr(31) || coalesce(v_email, '')
    );
    v_hash_003 := private.hash_secret(p_request_id::text);

    -- Replayed request (same id and same details): rotate and return the
    -- existing pass. It was issued under the terms accepted back then.
    select * into v_reg
    from public.registrations r
    where r.event_id = v_event.id
      and (
        r.request_id_hash = v_request_hash
        or (v_phone is null and r.request_id_hash = v_hash_004)
        -- The 003 key covered only the id: also require the same details.
        or (v_phone is null and r.request_id_hash = v_hash_003
            -- Names stored by 003 were not NFC-normalized; compare canonically (R4-06).
            and normalize(lower(r.first_name), NFC) = normalize(lower(v_first), NFC)
            and normalize(lower(r.last_name), NFC) = normalize(lower(v_last), NFC)
            and coalesce(r.email, '') = coalesce(v_email, '') and r.phone is null)
      )
    limit 1
    for update;

    if found then
      if v_reg.status <> 'registered'
         or v_reg.registered_at < now() - make_interval(mins => private.setting('request_replay_window_minutes', 30)) then
        return jsonb_build_object('ok', false, 'error', 'duplicate_request');
      end if;

      v_token := private.generate_pass_token();
      update public.registrations
      set pass_token_hash = private.hash_secret(v_token),
          token_issued_at = now(),
          token_version = token_version + 1
      where id = v_reg.id
      returning * into v_reg;

      return jsonb_build_object(
        'ok', true,
        'replayed', true,
        'token', v_token,
        'registration', jsonb_build_object(
          'first_name', v_reg.first_name,
          'last_name', v_reg.last_name,
          'status', v_reg.status,
          'registered_at', v_reg.registered_at
        ),
        'event', private.public_event_json(v_event)
      );
    end if;
  end if;

  if v_event.terms_required then
    if p_accept_terms is not true then
      return jsonb_build_object('ok', false, 'error', 'terms_not_accepted', 'field', 'terms');
    end if;
    v_terms_hash := private.hash_secret(v_event.terms_text);
    -- The attendee must have been shown exactly the current text.
    if p_terms_version is null or lower(btrim(p_terms_version)) <> encode(v_terms_hash, 'hex') then
      return jsonb_build_object('ok', false, 'error', 'terms_changed', 'field', 'terms',
                                'event', private.public_event_json(v_event));
    end if;
  end if;

  v_state := private.registration_state(v_event);
  if v_state <> 'open' then
    return jsonb_build_object('ok', false, 'error',
      case v_state when 'not_open' then 'registration_not_open' else 'registration_closed' end);
  end if;

  if v_event.max_attendees is not null then
    select count(*) into v_taken
    from public.registrations r
    where r.event_id = v_event.id and r.status <> 'revoked';
    if v_taken >= v_event.max_attendees then
      return jsonb_build_object('ok', false, 'error', 'event_full');
    end if;
  end if;

  v_token := private.generate_pass_token();

  insert into public.registrations (
    event_id, first_name, last_name, email, phone, pass_token_hash, request_id_hash, terms_accepted_at, terms_hash
  )
  values (
    v_event.id, v_first, v_last, v_email, v_phone, private.hash_secret(v_token), v_request_hash,
    case when v_event.terms_required then now() end,
    v_terms_hash
  )
  returning * into v_reg;

  return jsonb_build_object(
    'ok', true,
    'replayed', false,
    'token', v_token,
    'registration', jsonb_build_object(
      'first_name', v_reg.first_name,
      'last_name', v_reg.last_name,
      'status', v_reg.status,
      'registered_at', v_reg.registered_at
    ),
    'event', private.public_event_json(v_event)
  );
end;
$$;
