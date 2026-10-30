-- PassSystem: remediation of Codex review 3 (docs/CODEX_REVIEW_3.md, R3-01..R3-03).

-------------------------------------------------------------------------------
-- R3-01: one lock order for event edits and registrations
-------------------------------------------------------------------------------
-- The BEFORE UPDATE trigger from 007 took the capacity lock *after* the UPDATE
-- held the event row, while a registration takes the capacity lock first and
-- then needs a KEY SHARE lock on the event row for its foreign key (blocked by
-- a slug change): a cycle. Event updates now take no advisory lock at all.
-- Instead, a registration re-reads the event FOR SHARE after acquiring the
-- capacity lock. That waits for an in-flight edit to commit (and sees its
-- result), and makes a later edit wait until the registration commits.
-- FOR SHARE does not conflict with the KEY SHARE locks taken by admissions and
-- other registrations, so scanning never blocks registration.
drop trigger if exists events_capacity_lock on public.events;
drop function if exists private.lock_event_on_update();

-------------------------------------------------------------------------------
-- R3-02 + R3-03: setting the role of a pending invite
-------------------------------------------------------------------------------
-- The latest invite decides the role. The Auth user row is locked first, which
-- orders this against the confirming UPDATE (and its trigger): if the invite
-- was accepted in the meantime, administrator rights are granted directly.
-- Returns what actually happened: 'queued' (granted on acceptance), 'granted',
-- 'cleared' (staff invite), 'unchanged' (already-confirmed account, staff), or
-- 'not_found'.
drop function if exists public.mark_pending_admin(uuid, uuid);

create function public.set_pending_admin(p_user_id uuid, p_admin boolean, p_invited_by uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_confirmed timestamptz;
begin
  select u.email_confirmed_at into v_confirmed
  from auth.users u where u.id = p_user_id
  for update;
  if not found then
    return 'not_found';
  end if;

  if v_confirmed is not null then
    if p_admin then
      -- Accepted between creating the invite and this call: same intent.
      perform pg_advisory_xact_lock(hashtextextended('passsystem:admins', 0));
      update public.profiles set is_admin = true where id = p_user_id;
      delete from private.pending_admin_invites where user_id = p_user_id;
      return 'granted';
    end if;
    return 'unchanged';
  end if;

  if p_admin then
    insert into private.pending_admin_invites (user_id, invited_by)
    values (p_user_id, p_invited_by)
    on conflict (user_id) do update set invited_by = excluded.invited_by, created_at = now();
    return 'queued';
  end if;

  delete from private.pending_admin_invites where user_id = p_user_id;
  return 'cleared';
end;
$$;
revoke all on function public.set_pending_admin(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.set_pending_admin(uuid, boolean, uuid) to service_role;

-- Staff page: which pending invites will become administrators (admins only).
create function public.pending_admin_invites()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Not authorized' using errcode = '42501', hint = 'admin_required';
  end if;
  return query select p.user_id from private.pending_admin_invites p;
end;
$$;
revoke all on function public.pending_admin_invites() from public, anon, authenticated;
grant execute on function public.pending_admin_invites() to authenticated;

-------------------------------------------------------------------------------
-- register_for_event: re-read the event FOR SHARE under the capacity lock (R3-01)
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
            and lower(r.first_name) = lower(v_first) and lower(r.last_name) = lower(v_last)
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
