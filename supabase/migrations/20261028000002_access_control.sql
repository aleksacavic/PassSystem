-- PassSystem access control: authorization helpers, table privileges and RLS.
--
-- Model
--   * System administrators: profiles.is_admin = true. Full access to every event.
--   * Organizer (per event):  manage the event, its attendees and its operators.
--   * Operator  (per event):  scan passes for the event. No attendee list access.
--   * Anonymous attendees:    no table access at all. They use the public RPCs
--                             (get_public_event, register_for_event, get_pass).
--
-- Supabase grants broad default privileges on new public tables to anon and
-- authenticated. They are revoked here and only the minimum is re-granted, so
-- RLS is a second line of defence rather than the only one.

-------------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so policies do not recurse into RLS)
-------------------------------------------------------------------------------
create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

create function private.has_event_role(p_event_id uuid, p_roles public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    private.is_admin()
    or exists (
      select 1
      from public.event_staff s
      where s.event_id = p_event_id
        and s.user_id = (select auth.uid())
        and s.role = any (p_roles)
    )
  );
$$;

create function private.is_event_organizer(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_event_role(p_event_id, array['organizer']::public.staff_role[]);
$$;

create function private.is_event_staff(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_event_role(p_event_id, array['organizer', 'operator']::public.staff_role[]);
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.has_event_role(uuid, public.staff_role[]) to authenticated;
grant execute on function private.is_event_organizer(uuid) to authenticated;
grant execute on function private.is_event_staff(uuid) to authenticated;

-------------------------------------------------------------------------------
-- Table privileges
-------------------------------------------------------------------------------
revoke all on table public.profiles, public.events, public.registrations,
  public.event_staff, public.admission_logs from anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

-- profiles: read only; admin flag is changed through set_user_admin().
grant select on table public.profiles to authenticated;

-- events: created and edited directly through the API (RLS-checked).
grant select on table public.events to authenticated;
grant insert (
  name, slug, description, location, timezone, starts_at, ends_at,
  registration_opens_at, registration_closes_at, status, max_attendees
) on table public.events to authenticated;
grant update (
  name, slug, description, location, timezone, starts_at, ends_at,
  registration_opens_at, registration_closes_at, status, max_attendees
) on table public.events to authenticated;
grant delete on table public.events to authenticated;

-- registrations: organizers read attendee data, never credential hashes.
-- All writes go through SECURITY DEFINER functions.
grant select (
  id, event_id, first_name, last_name, email, status, registered_at,
  checked_in_at, checked_in_by, revoked_at, revoked_by, token_issued_at, token_version
) on table public.registrations to authenticated;

-- event_staff: read only; writes through add_event_staff()/remove_event_staff().
grant select on table public.event_staff to authenticated;

-- admission_logs: read only; written exclusively by admit_pass().
grant select on table public.admission_logs to authenticated;

-------------------------------------------------------------------------------
-- Row-level security
-------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.event_staff enable row level security;
alter table public.admission_logs enable row level security;


-- profiles
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));

-- events
create policy events_select_staff on public.events
  for select to authenticated
  using ((select private.is_event_staff(id)));

create policy events_insert_admin on public.events
  for insert to authenticated
  with check ((select private.is_admin()) and created_by = (select auth.uid()));

create policy events_update_organizer on public.events
  for update to authenticated
  using ((select private.is_event_organizer(id)))
  with check ((select private.is_event_organizer(id)));

create policy events_delete_admin on public.events
  for delete to authenticated
  using ((select private.is_admin()));

-- registrations
create policy registrations_select_organizer on public.registrations
  for select to authenticated
  using ((select private.is_event_organizer(event_id)));

-- event_staff
create policy event_staff_select on public.event_staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_event_organizer(event_id)));

-- admission_logs
create policy admission_logs_select_organizer on public.admission_logs
  for select to authenticated
  using ((select private.is_event_organizer(event_id)));
