-- PassSystem: data for wallet passes (Google Wallet, later Apple Wallet).
--
-- Called only by the `google-wallet` Edge Function with the service role. The
-- caller must present the raw pass token (the attendee's credential), so this
-- reveals nothing the pass page does not already show to the token holder.

create function public.wallet_pass_data(p_token text)
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

revoke all on function public.wallet_pass_data(text) from public, anon, authenticated;
grant execute on function public.wallet_pass_data(text) to service_role;
