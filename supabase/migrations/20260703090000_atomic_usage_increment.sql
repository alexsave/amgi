-- Atomic usage check-and-increment.
--
-- The edge functions previously read the usage row, compared it against the
-- tier limit in TypeScript, then wrote the incremented value back. Two
-- concurrent requests could both pass the check and overshoot the limit.
-- This RPC folds check + increment into a single guarded UPDATE so the limit
-- is enforced atomically. The limit itself is resolved by the caller (it
-- depends on subscription state that the edge function already loads) and
-- passed in; -1 means unlimited, amount 0 means "check only".
--
-- Safe to re-run.

create or replace function public.check_and_increment_usage(
  p_user_id uuid,
  p_field text,
  p_amount int,
  p_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage usage_tracking%rowtype;
begin
  if p_field not in (
    'realtime_sessions_started',
    'voice_evaluations_used',
    'card_audio_generations_used'
  ) then
    raise exception 'unknown usage field: %', p_field;
  end if;

  -- Guarded atomic increment: only applies when unlimited or within limit.
  execute format(
    'update usage_tracking
        set %1$I = %1$I + $1
      where user_id = $2
        and ($3 = -1 or %1$I + $1 <= $3)
      returning *',
    p_field
  )
  into v_usage
  using p_amount, p_user_id, p_limit;

  if v_usage.id is not null then
    return jsonb_build_object('allowed', true, 'usage', to_jsonb(v_usage));
  end if;

  -- Increment was blocked (or no row matched) — report current usage.
  select * into v_usage from usage_tracking where user_id = p_user_id;
  if not found then
    raise exception 'no usage_tracking row for user %', p_user_id;
  end if;

  return jsonb_build_object('allowed', false, 'usage', to_jsonb(v_usage));
end;
$$;

-- Edge functions call this with the service role; keep it away from clients.
revoke all on function public.check_and_increment_usage(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.check_and_increment_usage(uuid, text, int, int) to service_role;
