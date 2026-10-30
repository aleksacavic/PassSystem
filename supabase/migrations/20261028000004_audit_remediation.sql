-- PassSystem: remediation of the independent audit findings (2026-10-28).
-- See docs/AUDIT_REMEDIATION.md for the finding-by-finding mapping.
--
-- Applied on top of 001-003, which are already deployed; earlier migrations
-- are never edited.

-------------------------------------------------------------------------------
-- F-02: do not trust cf-connecting-ip by default
-------------------------------------------------------------------------------
-- Every install starts untrusted. Deployments behind Cloudflare (Supabase
-- Cloud) switch it on after the Staff page "Test header spoofing" check shows
-- forged values are replaced:
--   update private.settings set value = 1 where key = 'trust_cf_connecting_ip';
update private.settings
set value = 0,
    description = '1 only after the Staff page spoofing test shows clients cannot forge cf-connecting-ip (Supabase Cloud). Self-hosted without Cloudflare: 0.'
where key = 'trust_cf_connecting_ip';

-- Expose the raw cf-connecting-ip value to the admin-only diagnostic so the
-- Staff page can test whether a forged value is passed through.
create or replace function private.client_ip_info()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_headers jsonb;
  v_cf text;
  v_real text;
  v_xff text;
  v_xff_last text;
  v_ip text;
  v_source text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  if v_headers is null then
    return jsonb_build_object('ip', 'unknown', 'source', 'none');
  end if;
  v_cf := nullif(btrim(v_headers ->> 'cf-connecting-ip'), '');
  v_real := nullif(btrim(v_headers ->> 'x-real-ip'), '');
  v_xff := nullif(btrim(v_headers ->> 'x-forwarded-for'), '');
  if v_xff is not null then
    v_xff_last := nullif(btrim(regexp_replace(v_xff, '^.*,', '')), '');
  end if;

  if v_cf is not null and private.setting('trust_cf_connecting_ip', 0) = 1 then
    v_ip := v_cf; v_source := 'cf-connecting-ip';
  elsif v_real is not null then
    v_ip := v_real; v_source := 'x-real-ip';
  elsif v_xff_last is not null then
    v_ip := v_xff_last; v_source := 'x-forwarded-for(last)';
  else
    v_ip := 'unknown'; v_source := 'none';
  end if;

  return jsonb_build_object(
    'ip', left(v_ip, 64),
    'source', v_source,
    'trust_cf_connecting_ip', private.setting('trust_cf_connecting_ip', 0) = 1,
    'cf_connecting_ip_present', v_cf is not null,
    'cf_connecting_ip', left(v_cf, 64),
    'x_real_ip', v_real,
    'x_forwarded_for', v_xff
  );
end;
$$;

-------------------------------------------------------------------------------
-- F-03 (partial): group IPv6 clients by /64 for rate limiting
-------------------------------------------------------------------------------
-- One host usually controls a whole /64, so per-address IPv6 buckets do not
-- bind. IPv4 stays per address.
create or replace function private.client_fingerprint()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ip text := private.client_ip();
  v_key text := v_ip;
begin
  if position(':' in v_ip) > 0 then
    begin
      v_key := host(network(set_masklen(v_ip::inet, 64))) || '/64';
    exception when others then
      v_key := v_ip;
    end;
  end if;
  return encode(
    extensions.digest(
      (select a.value from private.app_secrets a where a.key = 'ip_hash_salt') || convert_to(v_key, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
end;
$$;

-------------------------------------------------------------------------------
-- F-10: reject invisible / bidi-control characters; require a letter or digit
-------------------------------------------------------------------------------
create or replace function private.clean_name(p_value text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v is null or v = '' or char_length(v) > p_max then null
    when v ~ '[[:cntrl:]]' or v ~ '[<>]' then null
    -- Unicode format characters: zero-width, bidi overrides/isolates, BOM, soft hyphen.
    when v ~ E'[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\u00AD]' then null
    when v !~ '[[:alnum:]]' then null
    else v
  end
  from (select normalize(btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')), NFC) as v) c;
$$;

-------------------------------------------------------------------------------
-- Per-event advisory lock (F-06): serializes capacity checks without locking
-- the events row, which scans need (FK checks) and which could deadlock with a
-- replayed registration.
-------------------------------------------------------------------------------
create or replace function private.lock_event_capacity(p_event_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('passsystem:capacity:' || p_event_id::text, 0));
$$;

-------------------------------------------------------------------------------
-- F-04 + F-06: register_for_event
-------------------------------------------------------------------------------
-- The idempotency key now covers the request body: replaying a request id with
-- different details is a different registration, never someone else's pass.
create or replace function public.register_for_event(
  p_slug text,
  p_first_name text,
  p_last_name text,
  p_email text default null,
  p_request_id uuid default null,
  p_website text default null
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
  v_token text;
  v_request_hash bytea;
  v_reg public.registrations;
  v_taken integer;
begin
  -- Rate limits (per client and per event). Counted before validation so that
  -- malformed floods are limited too.
  if not private.rate_limit_hit('reg:ip:m:' || v_fp, private.setting('register_per_ip_per_minute', 30), 60)
     or not private.rate_limit_hit('reg:ip:h:' || v_fp, private.setting('register_per_ip_per_hour', 400), 3600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Honeypot field: real users never see or fill it.
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

  select * into v_event from public.events e where e.slug = lower(btrim(p_slug));
  if not found or v_event.status in ('draft', 'archived') then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  if not private.rate_limit_hit('reg:event:' || v_event.id::text, private.setting('register_per_event_per_minute', 600), 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Serializes registrations (capacity, replay) for this event only.
  perform private.lock_event_capacity(v_event.id);

  v_request_hash := case
    when p_request_id is null then null
    else private.hash_secret(
      p_request_id::text || chr(31) || lower(v_first) || chr(31) || lower(v_last) || chr(31) || coalesce(v_email, '')
    )
  end;

  -- Replayed request (same id and same details): rotate and return the existing pass.
  if v_request_hash is not null then
    select * into v_reg
    from public.registrations r
    where r.event_id = v_event.id
      and r.request_id_hash = v_request_hash
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

  insert into public.registrations (event_id, first_name, last_name, email, pass_token_hash, request_id_hash)
  values (v_event.id, v_first, v_last, v_email, private.hash_secret(v_token), v_request_hash)
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

-------------------------------------------------------------------------------
-- F-01 + F-07: admit_pass with per-attempt idempotency
-------------------------------------------------------------------------------
-- The scanner sends one attempt id per detected credential and reuses it on
-- Retry. If the first request was committed but its response was lost (client
-- timeout), the retry returns that original result instead of "already used".
create table private.scan_attempts (
  operator_id uuid not null,
  attempt_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (operator_id, attempt_id)
);
create index scan_attempts_created_idx on private.scan_attempts (created_at);
revoke all on table private.scan_attempts from public, anon, authenticated;

drop function public.admit_pass(uuid, text);

create function public.admit_pass(p_event_id uuid, p_token text, p_attempt_id uuid default null)
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
  v_reg public.registrations;
  v_pass_event public.events;
  v_result public.admission_result;
  v_reason text;
  v_attendee jsonb := null;
  v_now timestamptz := clock_timestamp();
  v_details jsonb := '{}'::jsonb;
  v_registration_id uuid := null;
  v_checked_in_at timestamptz := null;
  v_prior jsonb;
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

  if v_token is not null then
    -- Lock first: a concurrent attempt with the same id has then committed (or
    -- rolled back) and its recorded result is visible below.
    select * into v_reg
    from public.registrations r
    where r.pass_token_hash = private.hash_secret(v_token)
    for update;
  end if;

  if p_attempt_id is not null then
    select a.response into v_prior
    from private.scan_attempts a
    where a.operator_id = v_uid and a.attempt_id = p_attempt_id;
    if found and (v_prior -> 'event' ->> 'id')::uuid = p_event_id then
      return v_prior || jsonb_build_object('replayed', true);
    end if;
  end if;

  if v_token is null or v_reg.id is null then
    v_result := 'invalid';
    v_reason := 'Pass not recognised.';
    v_details := jsonb_build_object('reason', case when v_token is null then 'malformed' else 'unknown_token' end);

  elsif v_reg.event_id <> p_event_id then
    v_result := 'wrong_event';
    select * into v_pass_event from public.events e where e.id = v_reg.event_id;
    v_details := jsonb_build_object('reason', 'wrong_event');
    -- Identity and the other event are only revealed (and logged) for staff
    -- who may see that event; otherwise this event's log must not reference it.
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
    insert into private.scan_attempts (operator_id, attempt_id, response)
    values (v_uid, p_attempt_id, v_response)
    on conflict do nothing;
    if random() < 0.01 then
      delete from private.scan_attempts where created_at < now() - interval '2 days';
    end if;
  end if;

  return v_response;
end;
$$;

revoke all on function public.admit_pass(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admit_pass(uuid, text, uuid) to authenticated;

-------------------------------------------------------------------------------
-- F-05: restoring a pass respects capacity
-------------------------------------------------------------------------------
create or replace function public.restore_registration(p_registration_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reg public.registrations;
  v_event public.events;
  v_taken integer;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id;
  if not found or not private.is_event_organizer(v_reg.event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;

  perform private.lock_event_capacity(v_reg.event_id);
  select * into v_reg from public.registrations r where r.id = p_registration_id for update;
  if v_reg.status <> 'revoked' then
    raise exception 'Only revoked passes can be restored' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  select * into v_event from public.events e where e.id = v_reg.event_id;
  if v_event.max_attendees is not null then
    select count(*) into v_taken
    from public.registrations r
    where r.event_id = v_event.id and r.status <> 'revoked';
    if v_taken >= v_event.max_attendees then
      raise exception 'The event is at capacity' using errcode = 'P0001', hint = 'event_full';
    end if;
  end if;

  update public.registrations
  set status = 'registered', revoked_at = null, revoked_by = null
  where id = v_reg.id;

  return jsonb_build_object('ok', true, 'status', 'registered');
end;
$$;

-------------------------------------------------------------------------------
-- F-08: only confirmed accounts can be staff; invited admins are granted on acceptance
-------------------------------------------------------------------------------
alter table public.profiles add column if not exists confirmed_at timestamptz;

update public.profiles p
set confirmed_at = u.email_confirmed_at
from auth.users u
where u.id = p.id and p.confirmed_at is distinct from u.email_confirmed_at;

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

  -- Administrator invites are granted only once the invite is accepted.
  -- app_metadata is writable by the service role only, never by the user.
  if new.email_confirmed_at is not null
     and coalesce(new.raw_app_meta_data ->> 'pending_admin', '') = 'true' then
    update public.profiles set is_admin = true where id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function private.handle_auth_user_change() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email, email_confirmed_at, raw_app_meta_data on auth.users
  for each row
  when (old.email is distinct from new.email
        or old.email_confirmed_at is distinct from new.email_confirmed_at
        or old.raw_app_meta_data is distinct from new.raw_app_meta_data)
  execute function private.handle_auth_user_change();

create or replace function public.add_event_staff(p_event_id uuid, p_email text, p_role public.staff_role)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_confirmed timestamptz;
  v_id uuid;
begin
  if not private.is_event_organizer(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  if p_role = 'organizer' and not private.is_admin() then
    raise exception 'Only administrators can assign organizers' using errcode = '42501', hint = 'admin_required';
  end if;

  select p.id, p.confirmed_at into v_user_id, v_confirmed
  from public.profiles p where lower(p.email) = lower(btrim(p_email));
  if v_user_id is null then
    raise exception 'No staff account with that email' using errcode = 'P0002', hint = 'user_not_found';
  end if;
  if v_confirmed is null then
    raise exception 'This person has not accepted their invite yet' using errcode = 'P0001', hint = 'user_not_confirmed';
  end if;

  -- Changing an existing organizer's role is an administrator decision too.
  if not private.is_admin() and exists (
    select 1 from public.event_staff s
    where s.event_id = p_event_id and s.user_id = v_user_id and s.role = 'organizer'
  ) then
    raise exception 'Only administrators can change an organizer''s role' using errcode = '42501', hint = 'admin_required';
  end if;

  insert into public.event_staff (event_id, user_id, role, created_by)
  values (p_event_id, v_user_id, p_role, auth.uid())
  on conflict (event_id, user_id) do update set role = excluded.role
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'user_id', v_user_id, 'role', p_role);
end;
$$;

-------------------------------------------------------------------------------
-- F-08 + F-09: set_user_admin requires a confirmed account and never leaves
-- zero administrators, even when two admins demote each other concurrently.
-------------------------------------------------------------------------------
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
  return jsonb_build_object('ok', true);
end;
$$;

-------------------------------------------------------------------------------
-- Privileges for the replaced private helpers (CREATE OR REPLACE keeps grants,
-- new objects get none). The four RLS helpers keep their existing grants.
-------------------------------------------------------------------------------
revoke all on function private.lock_event_capacity(uuid) from public, anon, authenticated;
revoke all on function private.client_fingerprint() from public, anon, authenticated;
revoke all on function private.client_ip_info() from public, anon, authenticated;
revoke all on function private.clean_name(text, integer) from public, anon, authenticated;
