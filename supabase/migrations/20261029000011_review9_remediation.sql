-- PassSystem: remediation of Codex review 9 (docs/CODEX_REVIEW_9.md, R9-02, R9-03).
-- R9-01 (stale edits overwriting an archive) is fixed in the frontend: every event
-- update states the version or status it expects (src/lib/api.ts updateEvent).

-------------------------------------------------------------------------------
-- R9-02: no active Wallet pass for an archived event
-------------------------------------------------------------------------------
create or replace function public.wallet_pass_data(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token text := private.normalize_pass_token(p_token);
  v_reg public.registrations;
  v_event public.events;
begin
  if v_token is null then
    return jsonb_build_object('ok', false, 'error', 'pass_not_found');
  end if;

  select * into v_reg from public.registrations r where r.pass_token_hash = private.hash_secret(v_token);
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pass_not_found');
  end if;
  if v_reg.status = 'revoked' then
    return jsonb_build_object('ok', false, 'error', 'pass_revoked');
  end if;

  select * into v_event from public.events e where e.id = v_reg.event_id;
  -- An archived event admits no one: do not hand out an active Wallet pass (R9-02).
  if v_event.status = 'archived' then
    return jsonb_build_object('ok', false, 'error', 'event_archived');
  end if;

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'registration', jsonb_build_object(
      'id', v_reg.id,
      'first_name', v_reg.first_name,
      'last_name', v_reg.last_name,
      'status', v_reg.status,
      'token_version', v_reg.token_version
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'name', v_event.name,
      'slug', v_event.slug,
      'location', v_event.location,
      'timezone', v_event.timezone,
      'starts_at', v_event.starts_at,
      'ends_at', v_event.ends_at,
      'status', v_event.status
    )
  );
end;
$$;

-------------------------------------------------------------------------------
-- R9-03: limits sized for a crowd behind one network address
-------------------------------------------------------------------------------
-- Limits count per network address (with cf-connecting-ip trusted, the public
-- address), not per person: venue Wi-Fi or carrier NAT puts a whole crowd
-- behind one. Starting values for about 1,000 arrivals in ten minutes behind
-- one address, with a retry each (docs/CODEX_REVIEW_9.md). They still stop a
-- single client flooding an event; size them up for larger on-site rushes.
update private.settings set value = 600 where key = 'register_per_ip_per_minute';
update private.settings set value = 6000 where key = 'register_per_ip_per_hour';
update private.settings set value = 3000 where key = 'pass_lookup_per_ip_per_minute';
update private.settings set value = 3000 where key = 'public_event_per_ip_per_minute';
update private.settings set value = 1200 where key = 'register_per_event_per_minute';

-- register_for_event as in 009, with a separate answer for the hourly limit.
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
  if not private.rate_limit_hit('reg:ip:m:' || v_fp, private.setting('register_per_ip_per_minute', 30), 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'window', 'minute');
  end if;
  -- Waiting a minute does not help with the hourly limit: say which one it was (R9-03).
  if not private.rate_limit_hit('reg:ip:h:' || v_fp, private.setting('register_per_ip_per_hour', 400), 3600) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'window', 'hour');
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
