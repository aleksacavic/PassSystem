-- PassSystem: remediation of Codex review 2 (docs/CODEX_REVIEW_2.md, R2-01..R2-06).

-------------------------------------------------------------------------------
-- R2-01: administrator invites are a single-use promotion on invite acceptance
-------------------------------------------------------------------------------
-- Pending promotions live in a private table (written by the invite-staff
-- Edge Function through a service-role-only RPC) and are consumed when the
-- account is confirmed. Explicit demotion cancels any pending promotion.
create table private.pending_admin_invites (
  user_id uuid primary key references auth.users (id) on delete cascade,
  invited_by uuid,
  created_at timestamptz not null default now()
);
revoke all on table private.pending_admin_invites from public, anon, authenticated;

-- Invites already sent with the older app_metadata flag (still unconfirmed).
insert into private.pending_admin_invites (user_id)
select u.id from auth.users u
where u.email_confirmed_at is null
  and coalesce(u.raw_app_meta_data ->> 'pending_admin', '') = 'true'
on conflict do nothing;

create function public.mark_pending_admin(p_user_id uuid, p_invited_by uuid default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.pending_admin_invites (user_id, invited_by)
  select u.id, p_invited_by from auth.users u
  where u.id = p_user_id and u.email_confirmed_at is null
  on conflict (user_id) do nothing;
$$;
revoke all on function public.mark_pending_admin(uuid, uuid) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function public.mark_pending_admin(uuid, uuid) to service_role;

create or replace function private.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, confirmed_at)
  values (
    new.id,
    lower(new.email),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.email_confirmed_at
  )
  on conflict (id) do update set email = excluded.email, confirmed_at = excluded.confirmed_at;

  -- Only on the transition to confirmed (invite accepted), and only once.
  if tg_op = 'UPDATE' and old.email_confirmed_at is null and new.email_confirmed_at is not null then
    delete from private.pending_admin_invites where user_id = new.id;
    if found then
      update public.profiles set is_admin = true where id = new.id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.handle_auth_user_change() from public, anon, authenticated;

-------------------------------------------------------------------------------
-- R2-04: administrator accounts cannot be deleted (demote first), enforced in
-- the deleting transaction itself
-------------------------------------------------------------------------------
-- Deleting an Auth user cascades to its profile. The profile row lock orders
-- this against set_user_admin's UPDATE: whichever commits first wins, and the
-- check below always sees the latest committed is_admin value.
create function private.guard_admin_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_admin and coalesce(current_setting('passsystem.allow_admin_delete', true), '') <> 'on' then
    raise exception 'Administrator accounts cannot be deleted; remove administrator rights first'
      using errcode = 'P0001', hint = 'remove_admin_first';
  end if;
  return old;
end;
$$;
revoke all on function private.guard_admin_profile_delete() from public, anon, authenticated;

create trigger profiles_guard_admin_delete
  before delete on public.profiles
  for each row execute function private.guard_admin_profile_delete();

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
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-------------------------------------------------------------------------------
-- R2-02: a scan attempt is bound to its event and credential, and serialized
-------------------------------------------------------------------------------
-- Cached responses are short-lived retry aids (seconds); rows from the older
-- format carry no credential binding and are dropped.
truncate private.scan_attempts;
alter table private.scan_attempts
  add column event_id uuid not null,
  add column credential_hash bytea not null;

create or replace function public.admit_pass(p_event_id uuid, p_token text, p_attempt_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event public.events;
  v_token text;
  v_credential_hash bytea;
  v_reg public.registrations;
  v_pass_event public.events;
  v_result public.admission_result;
  v_reason text;
  v_attendee jsonb := null;
  v_now timestamptz := clock_timestamp();
  v_details jsonb := '{}'::jsonb;
  v_registration_id uuid := null;
  v_checked_in_at timestamptz := null;
  v_prior private.scan_attempts;
  v_response jsonb;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501', hint = 'not_authenticated';
  end if;

  select * into v_event from public.events e where e.id = p_event_id;
  if not found or not private.is_event_staff(p_event_id) then
    raise exception 'Not authorized to scan for this event' using errcode = '42501', hint = 'not_authorized';
  end if;

  if v_event.status = 'archived' then
    raise exception 'Event is archived' using errcode = 'P0001', hint = 'event_archived';
  end if;

  v_token := private.normalize_pass_token(p_token);
  -- What was submitted, normalized when it parses as a pass (malformed input
  -- is bound too, so an attempt id can never be reused for different input).
  v_credential_hash := private.hash_secret(coalesce(v_token, 'raw:' || left(coalesce(p_token, ''), 500)));

  if p_attempt_id is not null then
    -- Serialize uses of one attempt id (taken before the registration row lock;
    -- nothing else takes these locks, so the order cannot deadlock).
    perform pg_advisory_xact_lock(hashtextextended('passsystem:attempt:' || v_uid::text || ':' || p_attempt_id::text, 0));
    select * into v_prior
    from private.scan_attempts a
    where a.operator_id = v_uid and a.attempt_id = p_attempt_id;
    if found then
      if v_prior.event_id = p_event_id and v_prior.credential_hash = v_credential_hash then
        return v_prior.response || jsonb_build_object('replayed', true);
      end if;
      raise exception 'This scan attempt was already used for a different pass. Scan again.'
        using errcode = 'P0001', hint = 'attempt_conflict';
    end if;
  end if;

  if v_token is not null then
    select * into v_reg
    from public.registrations r
    where r.pass_token_hash = private.hash_secret(v_token)
    for update;
  end if;

  if v_token is null or v_reg.id is null then
    v_result := 'invalid';
    v_reason := 'Pass not recognised.';
    v_details := jsonb_build_object('reason', case when v_token is null then 'malformed' else 'unknown_token' end);

  elsif v_reg.event_id <> p_event_id then
    v_result := 'wrong_event';
    select * into v_pass_event from public.events e where e.id = v_reg.event_id;
    v_details := jsonb_build_object('reason', 'wrong_event');
    if private.is_event_staff(v_reg.event_id) then
      v_registration_id := v_reg.id;
      v_details := v_details || jsonb_build_object('pass_event_id', v_reg.event_id);
      v_attendee := jsonb_build_object('first_name', v_reg.first_name, 'last_name', v_reg.last_name);
      v_reason := 'This pass is for a different event: ' || v_pass_event.name || '.';
    else
      v_reason := 'This pass is for a different event.';
    end if;

  elsif v_reg.status = 'revoked' then
    v_result := 'revoked';
    v_registration_id := v_reg.id;
    v_attendee := jsonb_build_object('first_name', v_reg.first_name, 'last_name', v_reg.last_name);
    v_reason := 'This pass has been revoked.';
    v_details := jsonb_build_object('reason', 'revoked');

  elsif v_reg.status = 'checked_in' then
    v_result := 'already_used';
    v_registration_id := v_reg.id;
    v_checked_in_at := v_reg.checked_in_at;
    v_attendee := jsonb_build_object('first_name', v_reg.first_name, 'last_name', v_reg.last_name);
    v_reason := 'This pass has already been used.';
    v_details := jsonb_build_object('reason', 'already_used', 'checked_in_at', v_reg.checked_in_at,
                                    'checked_in_by', v_reg.checked_in_by);

  else
    update public.registrations
    set status = 'checked_in',
        checked_in_at = v_now,
        checked_in_by = v_uid
    where id = v_reg.id and status = 'registered'
    returning * into v_reg;

    v_result := 'admitted';
    v_registration_id := v_reg.id;
    v_checked_in_at := v_reg.checked_in_at;
    v_attendee := jsonb_build_object('first_name', v_reg.first_name, 'last_name', v_reg.last_name);
    v_reason := 'Admitted.';
  end if;

  insert into public.admission_logs (registration_id, event_id, operator_id, attempted_at, result, details)
  values (v_registration_id, p_event_id, v_uid, v_now, v_result, v_details);

  v_response := jsonb_build_object(
    'result', v_result,
    'reason', v_reason,
    'attendee', v_attendee,
    'checked_in_at', v_checked_in_at,
    'event', jsonb_build_object('id', v_event.id, 'name', v_event.name),
    'scanned_at', v_now,
    'replayed', false
  );

  if p_attempt_id is not null then
    insert into private.scan_attempts (operator_id, attempt_id, event_id, credential_hash, response)
    values (v_uid, p_attempt_id, p_event_id, v_credential_hash, v_response);
    if random() < 0.01 then
      delete from private.scan_attempts where created_at < now() - interval '2 days';
    end if;
  end if;

  return v_response;
end;
$$;

-------------------------------------------------------------------------------
-- R2-03: consent is bound to the exact terms version the attendee was shown
-------------------------------------------------------------------------------
-- Every version of an event's terms is kept, keyed by its SHA-256 digest
-- (the value stored in registrations.terms_hash).
create table private.event_terms_versions (
  event_id uuid not null references public.events (id) on delete cascade,
  terms_hash bytea not null,
  terms_text text not null,
  first_seen_at timestamptz not null default now(),
  primary key (event_id, terms_hash)
);
revoke all on table private.event_terms_versions from public, anon, authenticated;

insert into private.event_terms_versions (event_id, terms_hash, terms_text)
select e.id, private.hash_secret(e.terms_text), e.terms_text
from public.events e where e.terms_text is not null
on conflict do nothing;

create function private.record_terms_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.terms_text is not null then
    insert into private.event_terms_versions (event_id, terms_hash, terms_text)
    values (new.id, private.hash_secret(new.terms_text), new.terms_text)
    on conflict do nothing;
  end if;
  return null;
end;
$$;
revoke all on function private.record_terms_version() from public, anon, authenticated;

create trigger events_record_terms_version
  after insert or update of terms_text on public.events
  for each row execute function private.record_terms_version();

create or replace function private.public_event_json(e public.events)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', e.name,
    'slug', e.slug,
    'description', e.description,
    'location', e.location,
    'timezone', e.timezone,
    'starts_at', e.starts_at,
    'ends_at', e.ends_at,
    'registration_opens_at', e.registration_opens_at,
    'registration_closes_at', e.registration_closes_at,
    'status', e.status,
    'terms_required', e.terms_required,
    'terms_text', case when e.terms_required then e.terms_text else null end,
    -- The browser sends this back with the acceptance.
    'terms_version', case when e.terms_required then encode(private.hash_secret(e.terms_text), 'hex') else null end
  );
$$;

-------------------------------------------------------------------------------
-- R2-06: event edits and registrations are ordered by the capacity lock
-------------------------------------------------------------------------------
-- An event update waits for registrations already holding the lock, and a
-- registration re-reads the event after acquiring it. Registration inserts
-- only take a KEY SHARE lock on the event row, which an UPDATE does not block,
-- so the two lock orders cannot deadlock.
create function private.lock_event_on_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_event_capacity(new.id);
  return new;
end;
$$;
revoke all on function private.lock_event_on_update() from public, anon, authenticated;

create trigger events_capacity_lock
  before update on public.events
  for each row execute function private.lock_event_on_update();

-- Whitespace-only phone input means "no phone", the same as in the browser.
create or replace function private.clean_phone(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or p_value ~ '^[[:space:]]*$' then null
    when char_length(p_value) > 40 then null
    else (
      select case when v ~ '^\+[1-9][0-9]{7,14}$' then v else null end
      from (select regexp_replace(btrim(p_value), '[[:space:]().-]', '', 'g') as v) c
    )
  end;
$$;
revoke all on function private.clean_phone(text) from public, anon, authenticated;

-------------------------------------------------------------------------------
-- register_for_event: terms version (R2-03), retries across key formats
-- (R2-05), event re-read under the lock (R2-06)
-------------------------------------------------------------------------------
drop function public.register_for_event(text, text, text, text, uuid, text, text, boolean);

create function public.register_for_event(
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

  -- Serializes registrations (capacity, replay) and event edits for this event.
  perform private.lock_event_capacity(v_event.id);
  -- Settings may have changed while waiting: decide on the current event.
  select * into v_event from public.events e where e.id = v_event.id;
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

revoke all on function public.register_for_event(text, text, text, text, uuid, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.register_for_event(text, text, text, text, uuid, text, text, boolean, text) to anon, authenticated;
