-- PassSystem: remediation of Codex review 5 (docs/CODEX_REVIEW_5.md, R5-01).

-------------------------------------------------------------------------------
-- R5-01: one invite at a time per email address
-------------------------------------------------------------------------------
-- Supabase Auth replaces a pending account's invite token on every invite, so
-- an older request that reaches Auth after a newer one would invalidate the
-- link the newer one already returned. Generations (009) fence the role, but
-- cannot fence that external call. So an invite now holds a lease on its
-- address from reservation until its role is saved (or it fails): a second
-- invite for the address meanwhile is refused (begin_invite returns null) and
-- can be retried a moment later.
--
-- The lease lasts 10 minutes, longer than an Edge Function request may run,
-- so a request cannot outlive it. A crashed request's lease simply expires.
-- Demotion still advances the generation without touching the lease: the
-- request in flight then finishes as 'stale' and releases it.
--
-- Locks taken, per path (each takes them in this order; no two paths take a
-- pair in opposite orders):
--   set_pending_admin : admin lock -> auth.users row -> generation row -> profile
--   set_user_admin    : admin lock -> profile -> generation row
--   invite acceptance : auth.users row -> profile -> generation row (share)
--   begin/end_invite  : generation row only
alter table private.invite_generations
  add column lease_generation bigint,
  add column lease_until timestamptz;

-- The new generation, or null while another invite for the address is in progress.
create or replace function public.begin_invite(p_email text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.invite_generations as g (email, generation, lease_generation, lease_until)
  values (lower(btrim(p_email)), 1, 1, now() + interval '10 minutes')
  on conflict (email) do update
    set generation = g.generation + 1,
        lease_generation = g.generation + 1,
        lease_until = now() + interval '10 minutes',
        updated_at = now()
    where g.lease_until is null or g.lease_until <= now()
  returning g.generation;
$$;

-- Releases the lease of a request that ends without saving a role (Auth
-- refused, account gone). Does nothing if the lease is no longer this request's.
create function public.end_invite(p_email text, p_generation bigint)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.invite_generations
  set lease_until = null
  where email = lower(btrim(p_email)) and lease_generation = p_generation;
$$;
revoke all on function public.end_invite(text, bigint) from public, anon, authenticated;
grant execute on function public.end_invite(text, bigint) to service_role;

-- As in 009, and releases this request's lease.
create or replace function public.set_pending_admin(
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
  -- This request is finishing: release its lease, whatever the outcome below.
  update private.invite_generations
  set lease_until = null
  where email = v_email and lease_generation = p_generation;
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
