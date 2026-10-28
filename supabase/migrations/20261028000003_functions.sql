-- PassSystem server-side operations.
--
-- Every function that touches credentials or changes registration state is
-- SECURITY DEFINER with an empty search_path and performs its own
-- authorization checks against auth.uid(). EXECUTE is revoked from PUBLIC and
-- granted explicitly per function at the bottom of this file.
--
-- Expected failures (closed registration, rate limit, invalid input) are
-- returned as {"ok": false, "error": "<code>"} instead of raised, so that the
-- transaction commits and rate-limit counters are kept.

-------------------------------------------------------------------------------
-- Internal helpers
-------------------------------------------------------------------------------
create function private.setting(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.value from private.settings s where s.key = p_key), p_default);
$$;

-- Best-effort client IP from the request headers forwarded by the API gateway.
--
-- Supabase Cloud sits behind Cloudflare, which overwrites `cf-connecting-ip`
-- with the real client address, so it is trusted first (setting
-- trust_cf_connecting_ip = 1). Self-hosted deployments without Cloudflare must
-- set it to 0, because clients can send that header themselves. Next comes
-- `x-real-ip` (set by the Kong gateway from the TCP peer) and finally the
-- right-most X-Forwarded-For entry (appended by the nearest proxy). The
-- left-most X-Forwarded-For entry is client-controlled and never used.
-- Verify on a deployment with: select public.diagnose_client_ip(); (admin only)
create function private.client_ip_info()
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

  if v_cf is not null and private.setting('trust_cf_connecting_ip', 1) = 1 then
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
    'cf_connecting_ip_present', v_cf is not null,
    'x_real_ip', v_real,
    'x_forwarded_for', v_xff
  );
end;
$$;

create function private.client_ip()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.client_ip_info() ->> 'ip';
$$;

-- Pseudonymous, salted identifier for the client IP (raw IPs are never stored).
create function private.client_fingerprint()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      (select a.value from private.app_secrets a where a.key = 'ip_hash_salt')
        || convert_to(private.client_ip(), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

-- Fixed-window counter. Returns true when the call is within the limit.
create function private.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_limit is null or p_limit <= 0 then
    return true;
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into private.rate_limit_buckets as b (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = b.hits + 1
  returning b.hits into v_hits;

  -- Opportunistic cleanup of expired windows (~1% of calls).
  if random() < 0.01 then
    delete from private.rate_limit_buckets where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_limit;
end;
$$;

-- 24 Crockford base32 characters = 120 bits from the CSPRNG.
create function private.generate_pass_token()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := extensions.gen_random_bytes(15);
  v_out text := '';
  v_val integer;
begin
  for i in 0..23 loop
    v_val := 0;
    for j in 0..4 loop
      v_val := v_val * 2 + get_bit(v_bytes, i * 5 + j);
    end loop;
    v_out := v_out || substr(v_alphabet, v_val + 1, 1);
  end loop;
  return v_out;
end;
$$;

-- Canonical form: uppercase, separators removed, Crockford aliases resolved.
-- Returns null if the input cannot be a pass token.
create function private.normalize_pass_token(p_input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_input is null or char_length(p_input) > 200 then null
    else (
      select case when t ~ '^[0-9A-HJKMNP-TV-Z]{24}$' then t else null end
      from (
        select translate(upper(regexp_replace(p_input, '[\s-]', '', 'g')), 'OIL', '011') as t
      ) n
    )
  end;
$$;

create function private.hash_secret(p_value text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(convert_to(p_value, 'UTF8'), 'sha256');
$$;

-- Collapse whitespace, strip, reject control characters. Returns null if invalid.
create function private.clean_name(p_value text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v is null or v = '' or char_length(v) > p_max or v ~ '[[:cntrl:]]' or v ~ '[<>]' then null
    else v
  end
  from (select btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')) as v) c;
$$;

-- Registration availability for an event row.
create function private.registration_state(e public.events)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when e.status = 'draft' then 'draft'
    when e.status = 'archived' then 'archived'
    when e.status = 'closed' then 'closed'
    when e.registration_opens_at is not null and now() < e.registration_opens_at then 'not_open'
    when e.registration_closes_at is not null and now() >= e.registration_closes_at then 'closed'
    when e.registration_closes_at is null and e.ends_at is not null and now() >= e.ends_at then 'closed'
    else 'open'
  end;
$$;

create function private.public_event_json(e public.events)
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
    'status', e.status
  );
$$;

-------------------------------------------------------------------------------
-- Public (anonymous) operations
-------------------------------------------------------------------------------

-- Public event details for the registration page. Draft events are visible
-- only to their staff (preview); archived events are hidden.
create function public.get_public_event(p_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event public.events;
  v_state text;
  v_taken integer;
begin
  if not private.rate_limit_hit(
    'event:' || private.client_fingerprint(),
    private.setting('public_event_per_ip_per_minute', 300), 60
  ) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v_event from public.events e where e.slug = lower(btrim(p_slug));

  if not found
     or v_event.status = 'archived'
     or (v_event.status = 'draft' and not private.is_event_staff(v_event.id)) then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  v_state := private.registration_state(v_event);

  if v_state = 'open' and v_event.max_attendees is not null then
    select count(*) into v_taken
    from public.registrations r
    where r.event_id = v_event.id and r.status <> 'revoked';
    if v_taken >= v_event.max_attendees then
      v_state := 'full';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'event', private.public_event_json(v_event),
    'registration_state', v_state
  );
end;
$$;

-- Anonymous self-registration. Returns the raw pass token exactly once.
--
-- p_request_id is a random UUID generated by the browser for one form
-- submission. If the same request is replayed (lost response, retry) within
-- the replay window, the existing registration is returned with a freshly
-- rotated token instead of creating a duplicate; only the original requester
-- knows the request id, so this does not leak or duplicate passes.
create function public.register_for_event(
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

  -- Lock the event row: serializes capacity checks for the event.
  select * into v_event from public.events e where e.slug = lower(btrim(p_slug)) for update;
  if not found or v_event.status in ('draft', 'archived') then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  if not private.rate_limit_hit('reg:event:' || v_event.id::text, private.setting('register_per_event_per_minute', 600), 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  v_request_hash := case when p_request_id is null then null else private.hash_secret(p_request_id::text) end;

  -- Replayed request: rotate and return the existing pass.
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

-- Private pass page lookup by raw token (the token is the only credential).
create function public.get_pass(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text := private.normalize_pass_token(p_token);
  v_reg public.registrations;
  v_event public.events;
begin
  if not private.rate_limit_hit(
    'pass:' || private.client_fingerprint(),
    private.setting('pass_lookup_per_ip_per_minute', 120), 60
  ) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  if v_token is null then
    return jsonb_build_object('ok', false, 'error', 'pass_not_found');
  end if;

  select * into v_reg from public.registrations r where r.pass_token_hash = private.hash_secret(v_token);
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pass_not_found');
  end if;

  select * into v_event from public.events e where e.id = v_reg.event_id;

  return jsonb_build_object(
    'ok', true,
    'pass', jsonb_build_object(
      'first_name', v_reg.first_name,
      'last_name', v_reg.last_name,
      'status', v_reg.status,
      'registered_at', v_reg.registered_at,
      'checked_in_at', v_reg.checked_in_at
    ),
    'event', private.public_event_json(v_event)
  );
end;
$$;

-------------------------------------------------------------------------------
-- Door operations
-------------------------------------------------------------------------------

-- Validate a scanned pass and atomically admit it.
--
-- Atomicity: the registration row is locked with SELECT ... FOR UPDATE. A
-- concurrent scan of the same pass blocks until the first transaction commits
-- and then re-reads the row as checked_in, so exactly one scan is admitted.
create function public.admit_pass(p_event_id uuid, p_token text)
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
    v_registration_id := v_reg.id;
    select * into v_pass_event from public.events e where e.id = v_reg.event_id;
    v_details := jsonb_build_object('reason', 'wrong_event', 'pass_event_id', v_reg.event_id);
    -- Only reveal identity / other event name to staff who may see that event.
    if private.is_event_staff(v_reg.event_id) then
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

  return jsonb_build_object(
    'result', v_result,
    'reason', v_reason,
    'attendee', v_attendee,
    'checked_in_at', v_checked_in_at,
    'event', jsonb_build_object('id', v_event.id, 'name', v_event.name),
    'scanned_at', v_now
  );
end;
$$;

-------------------------------------------------------------------------------
-- Organizer operations
-------------------------------------------------------------------------------

create function public.revoke_registration(p_registration_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reg public.registrations;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id for update;
  if not found or not private.is_event_organizer(v_reg.event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  if v_reg.status <> 'registered' then
    raise exception 'Only unused passes can be revoked' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  update public.registrations
  set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
  where id = v_reg.id;

  return jsonb_build_object('ok', true, 'status', 'revoked');
end;
$$;

create function public.restore_registration(p_registration_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reg public.registrations;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id for update;
  if not found or not private.is_event_organizer(v_reg.event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  if v_reg.status <> 'revoked' then
    raise exception 'Only revoked passes can be restored' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  update public.registrations
  set status = 'registered', revoked_at = null, revoked_by = null
  where id = v_reg.id;

  return jsonb_build_object('ok', true, 'status', 'registered');
end;
$$;

-- Issue a new token for an unused pass. The previous token stops working
-- immediately. The new token is returned once so the organizer can hand the
-- pass to the attendee (e.g. lost link).
create function public.reissue_pass(p_registration_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reg public.registrations;
  v_token text;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id for update;
  if not found or not private.is_event_organizer(v_reg.event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  if v_reg.status <> 'registered' then
    raise exception 'Only unused passes can be reissued' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  v_token := private.generate_pass_token();
  update public.registrations
  set pass_token_hash = private.hash_secret(v_token),
      request_id_hash = null,
      token_issued_at = now(),
      token_version = token_version + 1
  where id = v_reg.id;

  return jsonb_build_object('ok', true, 'token', v_token);
end;
$$;

-- Event list with live counters, restricted to events the caller may see.
create function public.get_event_summaries(p_event_id uuid default null)
returns table (
  id uuid,
  name text,
  slug text,
  status public.event_status,
  starts_at timestamptz,
  ends_at timestamptz,
  location text,
  timezone text,
  max_attendees integer,
  my_role text,
  registered_count bigint,
  checked_in_count bigint,
  revoked_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.id, e.name, e.slug, e.status, e.starts_at, e.ends_at, e.location, e.timezone, e.max_attendees,
    case
      when private.is_admin() then 'admin'
      else (select s.role::text from public.event_staff s where s.event_id = e.id and s.user_id = auth.uid())
    end as my_role,
    coalesce(c.total, 0) as registered_count,
    coalesce(c.checked_in, 0) as checked_in_count,
    coalesce(c.revoked, 0) as revoked_count
  from public.events e
  left join lateral (
    select
      count(*) filter (where r.status <> 'revoked') as total,
      count(*) filter (where r.status = 'checked_in') as checked_in,
      count(*) filter (where r.status = 'revoked') as revoked
    from public.registrations r
    where r.event_id = e.id
  ) c on true
  where auth.uid() is not null
    and (p_event_id is null or e.id = p_event_id)
    and private.is_event_staff(e.id)
  order by e.starts_at desc;
$$;

-- Staff assigned to an event (organizers and admins only).
create function public.list_event_staff(p_event_id uuid)
returns table (
  id uuid,
  user_id uuid,
  email text,
  display_name text,
  role public.staff_role,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_event_organizer(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  return query
    select s.id, s.user_id, p.email, p.display_name, s.role, s.created_at
    from public.event_staff s
    join public.profiles p on p.id = s.user_id
    where s.event_id = p_event_id
    order by s.role, p.email;
end;
$$;

-- Assign an existing staff account (by email) to an event.
-- Organizers may add operators; only administrators may add organizers.
create function public.add_event_staff(p_event_id uuid, p_email text, p_role public.staff_role)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_id uuid;
begin
  if not private.is_event_organizer(p_event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  if p_role = 'organizer' and not private.is_admin() then
    raise exception 'Only administrators can assign organizers' using errcode = '42501', hint = 'admin_required';
  end if;

  select p.id into v_user_id from public.profiles p where lower(p.email) = lower(btrim(p_email));
  if v_user_id is null then
    raise exception 'No staff account with that email' using errcode = 'P0002', hint = 'user_not_found';
  end if;

  insert into public.event_staff (event_id, user_id, role, created_by)
  values (p_event_id, v_user_id, p_role, auth.uid())
  on conflict (event_id, user_id) do update set role = excluded.role
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'user_id', v_user_id, 'role', p_role);
end;
$$;

create function public.remove_event_staff(p_staff_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.event_staff;
begin
  select * into v_row from public.event_staff s where s.id = p_staff_id;
  if not found or not private.is_event_organizer(v_row.event_id) then
    raise exception 'Not authorized' using errcode = '42501', hint = 'not_authorized';
  end if;
  if v_row.role = 'organizer' and not private.is_admin() then
    raise exception 'Only administrators can remove organizers' using errcode = '42501', hint = 'admin_required';
  end if;

  delete from public.event_staff where id = p_staff_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Grant or revoke system administrator rights (administrators only).
create function public.set_user_admin(p_user_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Not authorized' using errcode = '42501', hint = 'admin_required';
  end if;
  if not p_is_admin and p_user_id = auth.uid() then
    raise exception 'You cannot remove your own administrator rights' using errcode = 'P0001', hint = 'self_demotion';
  end if;

  update public.profiles set is_admin = p_is_admin where id = p_user_id;
  if not found then
    raise exception 'User not found' using errcode = 'P0002', hint = 'user_not_found';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Deployment check: which header the rate limiter uses for the caller's IP.
create function public.diagnose_client_ip()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Not authorized' using errcode = '42501', hint = 'admin_required';
  end if;
  return private.client_ip_info();
end;
$$;

-- Bootstrap: promote an existing auth user to administrator.
-- Not exposed through the API; run from the SQL editor / psql as the owner:
--   select private.bootstrap_admin('owner@example.com');
create function private.bootstrap_admin(p_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select u.id into v_id from auth.users u where lower(u.email) = lower(btrim(p_email));
  if v_id is null then
    raise exception 'No auth user with email %. Create the user in Supabase Auth first.', p_email;
  end if;
  insert into public.profiles (id, email, is_admin)
  values (v_id, lower(btrim(p_email)), true)
  on conflict (id) do update set is_admin = true;
  return 'Administrator granted to ' || lower(btrim(p_email));
end;
$$;

-------------------------------------------------------------------------------
-- Function privileges
-------------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.has_event_role(uuid, public.staff_role[]) to authenticated;
grant execute on function private.is_event_organizer(uuid) to authenticated;
grant execute on function private.is_event_staff(uuid) to authenticated;

revoke all on function public.get_public_event(text) from public, anon, authenticated;
revoke all on function public.register_for_event(text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.get_pass(text) from public, anon, authenticated;
revoke all on function public.admit_pass(uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_registration(uuid) from public, anon, authenticated;
revoke all on function public.restore_registration(uuid) from public, anon, authenticated;
revoke all on function public.reissue_pass(uuid) from public, anon, authenticated;
revoke all on function public.get_event_summaries(uuid) from public, anon, authenticated;
revoke all on function public.list_event_staff(uuid) from public, anon, authenticated;
revoke all on function public.add_event_staff(uuid, text, public.staff_role) from public, anon, authenticated;
revoke all on function public.remove_event_staff(uuid) from public, anon, authenticated;
revoke all on function public.set_user_admin(uuid, boolean) from public, anon, authenticated;
revoke all on function public.diagnose_client_ip() from public, anon, authenticated;

-- Public attendee operations.
grant execute on function public.get_public_event(text) to anon, authenticated;
grant execute on function public.register_for_event(text, text, text, text, uuid, text) to anon, authenticated;
grant execute on function public.get_pass(text) to anon, authenticated;

-- Staff operations (each performs its own authorization check).
grant execute on function public.admit_pass(uuid, text) to authenticated;
grant execute on function public.revoke_registration(uuid) to authenticated;
grant execute on function public.restore_registration(uuid) to authenticated;
grant execute on function public.reissue_pass(uuid) to authenticated;
grant execute on function public.get_event_summaries(uuid) to authenticated;
grant execute on function public.list_event_staff(uuid) to authenticated;
grant execute on function public.add_event_staff(uuid, text, public.staff_role) to authenticated;
grant execute on function public.remove_event_staff(uuid) to authenticated;
grant execute on function public.set_user_admin(uuid, boolean) to authenticated;
grant execute on function public.diagnose_client_ip() to authenticated;

-- Future objects in public must be granted explicitly.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
