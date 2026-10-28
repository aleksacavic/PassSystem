-- PassSystem: per-event attendance terms (accepted before a pass is issued)
-- and an optional attendee phone number in international format.

-------------------------------------------------------------------------------
-- Default attendance terms (template; have it reviewed by a UAE lawyer)
-------------------------------------------------------------------------------
create function private.default_terms_text()
returns text
language sql
immutable
set search_path = ''
as $$
  select $terms$Attendance terms

1. Private social event. This is a private social and cultural gathering. It is not political, religious or commercial in nature. No political or religious campaigning, promotion, fundraising or collection of donations takes place at the event.

2. Open to everyone. The organizers welcome all guests without distinction as to nationality, religion, race, colour, ethnic origin or gender, in line with UAE Federal Decree-Law No. 34 of 2023 on Combating Discrimination, Hatred and Extremism.

3. Respect for UAE law and customs. I will comply with the laws of the United Arab Emirates, respect public morals and local customs, and follow the instructions of the organizers and venue staff. I will not engage in political activity, or in speech or conduct that is offensive, discriminatory, or insults religions, the State or its symbols.

4. Photos and privacy. I will not photograph, film or publish other guests without their consent, in line with UAE Federal Decree-Law No. 34 of 2021 on Combatting Rumours and Cybercrimes.

5. Personal data. I consent to the organizers processing my name and, if I provide them, my email address and phone number, only to manage registration and entry to this event, in line with UAE Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data. My data will not be sold or used for marketing.

6. Own responsibility. I attend voluntarily and am responsible for my own conduct and belongings. To the extent permitted by UAE law, the organizers are not liable for any loss, damage or injury arising from my attendance.

7. Admission. My pass is personal and valid for one entry. The organizers may refuse entry, or ask a guest to leave, if these terms are not respected.$terms$;
$$;

-- Staff UI: prefill new events and "Reset to default".
create function public.default_event_terms()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.default_terms_text();
$$;

revoke all on function private.default_terms_text() from public, anon, authenticated;
-- Column defaults run with the inserting role's privileges (staff via the API,
-- the service role in scripts and Edge Functions).
grant usage on schema private to service_role;
grant execute on function private.default_terms_text() to authenticated, service_role;
revoke all on function public.default_event_terms() from public, anon, authenticated;
grant execute on function public.default_event_terms() to authenticated;

-------------------------------------------------------------------------------
-- Columns
-------------------------------------------------------------------------------
alter table public.events
  add column terms_required boolean not null default true,
  add column terms_text text default private.default_terms_text()
    check (terms_text is null or char_length(terms_text) <= 10000),
  add constraint events_terms_present check (not terms_required or char_length(btrim(coalesce(terms_text, ''))) > 0);

-- Existing events get the default text (and require acceptance) like new ones.
update public.events set terms_text = private.default_terms_text() where terms_text is null;

alter table public.registrations
  add column phone text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column terms_accepted_at timestamptz,
  -- sha256 of the exact terms text the attendee accepted (proof of what was shown).
  add column terms_hash bytea check (terms_hash is null or octet_length(terms_hash) = 32);

grant insert (terms_required, terms_text) on table public.events to authenticated;
grant update (terms_required, terms_text) on table public.events to authenticated;
grant select (phone, terms_accepted_at) on table public.registrations to authenticated;

-------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------
-- "+971 50 123-4567" / "(+44) 20 7946 0958" -> "+971501234567". Null if not E.164.
create function private.clean_phone(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    when char_length(p_value) > 40 then null
    else (
      select case when v ~ '^\+[1-9][0-9]{7,14}$' then v else null end
      from (select regexp_replace(btrim(p_value), '[\s().-]', '', 'g') as v) c
    )
  end;
$$;
revoke all on function private.clean_phone(text) from public, anon, authenticated;

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
    'terms_text', case when e.terms_required then e.terms_text else null end
  );
$$;

-------------------------------------------------------------------------------
-- register_for_event: optional phone, required acceptance of the event terms
-------------------------------------------------------------------------------
drop function public.register_for_event(text, text, text, text, uuid, text);

create function public.register_for_event(
  p_slug text,
  p_first_name text,
  p_last_name text,
  p_email text default null,
  p_request_id uuid default null,
  p_website text default null,
  p_phone text default null,
  p_accept_terms boolean default false
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

  if p_phone is not null and btrim(p_phone) <> '' then
    v_phone := private.clean_phone(p_phone);
    if v_phone is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_input', 'field', 'phone');
    end if;
  end if;

  select * into v_event from public.events e where e.slug = lower(btrim(p_slug));
  if not found or v_event.status in ('draft', 'archived') then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  if v_event.terms_required and p_accept_terms is not true then
    return jsonb_build_object('ok', false, 'error', 'terms_not_accepted', 'field', 'terms');
  end if;

  if not private.rate_limit_hit('reg:event:' || v_event.id::text, private.setting('register_per_event_per_minute', 600), 60) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- Serializes registrations (capacity, replay) for this event only.
  perform private.lock_event_capacity(v_event.id);

  v_request_hash := case
    when p_request_id is null then null
    else private.hash_secret(
      p_request_id::text || chr(31) || lower(v_first) || chr(31) || lower(v_last)
        || chr(31) || coalesce(v_email, '') || chr(31) || coalesce(v_phone, '')
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

  insert into public.registrations (
    event_id, first_name, last_name, email, phone, pass_token_hash, request_id_hash, terms_accepted_at, terms_hash
  )
  values (
    v_event.id, v_first, v_last, v_email, v_phone, private.hash_secret(v_token), v_request_hash,
    case when v_event.terms_required then now() end,
    case when v_event.terms_required then private.hash_secret(v_event.terms_text) end
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

revoke all on function public.register_for_event(text, text, text, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.register_for_event(text, text, text, text, uuid, text, text, boolean) to anon, authenticated;
