-- PassSystem core schema
-- Events, registrations (passes), staff assignments, admission logs and the
-- private support objects (rate limiting, settings, secrets).
--
-- All timestamps are timestamptz (stored in UTC). Every table in the exposed
-- `public` schema has row-level security enabled (see the RLS migration).

create extension if not exists pgcrypto with schema extensions;

-- Private schema: never exposed through the Data API (PostgREST only exposes
-- the schemas listed in the API settings, `public` by default).
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-------------------------------------------------------------------------------
-- Enumerations
-------------------------------------------------------------------------------
create type public.event_status as enum ('draft', 'published', 'closed', 'archived');
create type public.registration_status as enum ('registered', 'checked_in', 'revoked');
create type public.staff_role as enum ('organizer', 'operator');
create type public.admission_result as enum ('admitted', 'already_used', 'invalid', 'revoked', 'wrong_event');

-------------------------------------------------------------------------------
-- Staff profiles (one row per Supabase Auth user)
-------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text check (display_name is null or char_length(display_name) <= 200),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index profiles_email_lower_key on public.profiles (lower(email)) where email is not null;

comment on table public.profiles is
  'Staff identity mirror of auth.users. is_admin marks system administrators. Rows are created by trigger; attendees never have profiles.';

-------------------------------------------------------------------------------
-- Events
-------------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  description text check (description is null or char_length(description) <= 5000),
  location text check (location is null or char_length(location) <= 300),
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  starts_at timestamptz not null,
  ends_at timestamptz,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  status public.event_status not null default 'draft',
  max_attendees integer check (max_attendees is null or max_attendees between 1 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  constraint events_slug_key unique (slug),
  constraint events_ends_after_start check (ends_at is null or ends_at >= starts_at),
  constraint events_registration_window check (
    registration_opens_at is null or registration_closes_at is null
    or registration_closes_at > registration_opens_at
  )
);

create index events_starts_at_idx on public.events (starts_at desc);
create index events_status_idx on public.events (status);

comment on column public.events.slug is 'Public identifier used in the registration URL /e/<slug>.';
comment on column public.events.timezone is 'IANA time zone used to display event times to attendees.';

-------------------------------------------------------------------------------
-- Registrations (one per issued pass)
-------------------------------------------------------------------------------
create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete restrict,
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  email text check (
    email is null
    or (char_length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  -- SHA-256 of the normalized pass token. The raw token is never stored.
  pass_token_hash bytea not null check (octet_length(pass_token_hash) = 32),
  -- SHA-256 of the client-generated idempotency key of the registration request.
  request_id_hash bytea check (request_id_hash is null or octet_length(request_id_hash) = 32),
  status public.registration_status not null default 'registered',
  registered_at timestamptz not null default now(),
  checked_in_at timestamptz,
  checked_in_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  token_issued_at timestamptz not null default now(),
  token_version integer not null default 1,
  constraint registrations_pass_token_hash_key unique (pass_token_hash),
  constraint registrations_checkin_consistency check (
    (status = 'checked_in' and checked_in_at is not null)
    or (status = 'registered' and checked_in_at is null and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index registrations_request_id_key
  on public.registrations (event_id, request_id_hash) where request_id_hash is not null;
create index registrations_event_status_idx on public.registrations (event_id, status);
create index registrations_event_registered_idx on public.registrations (event_id, registered_at desc);
create index registrations_event_name_idx on public.registrations (event_id, lower(last_name), lower(first_name));

comment on column public.registrations.pass_token_hash is
  'sha256(normalized pass token). The token itself is only returned to the attendee once (and on organizer reissue).';

-------------------------------------------------------------------------------
-- Event staff assignments
-------------------------------------------------------------------------------
create table public.event_staff (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.staff_role not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  constraint event_staff_event_user_key unique (event_id, user_id)
);

create index event_staff_user_idx on public.event_staff (user_id);

-------------------------------------------------------------------------------
-- Admission logs (every server-validated scan attempt)
-------------------------------------------------------------------------------
create table public.admission_logs (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid references public.registrations (id) on delete set null,
  event_id uuid not null references public.events (id) on delete cascade,
  operator_id uuid references auth.users (id) on delete set null,
  attempted_at timestamptz not null default now(),
  result public.admission_result not null,
  details jsonb not null default '{}'::jsonb
);

create index admission_logs_event_attempted_idx on public.admission_logs (event_id, attempted_at desc);
create index admission_logs_registration_idx on public.admission_logs (registration_id);

comment on table public.admission_logs is
  'Audit trail of scan attempts. Never contains raw pass tokens.';

-------------------------------------------------------------------------------
-- Private support objects
-------------------------------------------------------------------------------

-- Tunable integer settings (rate limits). Change with plain SQL, no redeploy needed.
create table private.settings (
  key text primary key,
  value integer not null,
  description text
);

insert into private.settings (key, value, description) values
  ('register_per_ip_per_minute', 30, 'Registrations accepted from one client IP per minute (venue Wi-Fi shares IPs, keep generous).'),
  ('register_per_ip_per_hour', 400, 'Registrations accepted from one client IP per hour.'),
  ('register_per_event_per_minute', 600, 'Registrations accepted for a single event per minute (flood ceiling).'),
  ('pass_lookup_per_ip_per_minute', 120, 'Pass page lookups from one client IP per minute.'),
  ('public_event_per_ip_per_minute', 300, 'Public event page lookups from one client IP per minute.'),
  ('request_replay_window_minutes', 30, 'Window in which a repeated registration request id returns the same registration.');

-- Install-specific secret used to pseudonymize client IPs in rate-limit buckets.
create table private.app_secrets (
  key text primary key,
  value bytea not null
);

insert into private.app_secrets (key, value)
values ('ip_hash_salt', extensions.gen_random_bytes(32));

create table private.rate_limit_buckets (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

create index rate_limit_buckets_window_idx on private.rate_limit_buckets (window_start);

-------------------------------------------------------------------------------
-- Generic triggers
-------------------------------------------------------------------------------
create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger events_touch_updated_at
  before update on public.events
  for each row execute function private.touch_updated_at();

-- Validate event fields that CHECK constraints cannot express.
create function private.validate_event()
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
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger events_validate
  before insert or update on public.events
  for each row execute function private.validate_event();

-- Mirror auth.users into public.profiles.
create function private.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_auth_user_change();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_auth_user_change();

-- The creator of an event becomes its organizer.
create function private.handle_event_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null and exists (select 1 from public.profiles where id = new.created_by) then
    insert into public.event_staff (event_id, user_id, role, created_by)
    values (new.id, new.created_by, 'organizer', new.created_by)
    on conflict (event_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger events_add_creator_as_organizer
  after insert on public.events
  for each row execute function private.handle_event_created();
