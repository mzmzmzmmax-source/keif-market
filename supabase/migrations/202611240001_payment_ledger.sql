-- Payment ledger for immediate product-only checkout.
-- Apply only to a Supabase development branch first; do not run on production until reviewed.
begin;

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.orders(id) on delete restrict,
  idempotency_key uuid not null unique,
  amount_toman bigint not null check (amount_toman > 0),
  currency text not null default 'IRT' check (currency = 'IRT'),
  provider text not null default 'zarinpal' check (provider = 'zarinpal'),
  authority text unique,
  ref_id text,
  status text not null default 'creating'
    check (status in ('creating','pending','verified','failed','expired','reversed')),
  request_code integer,
  verify_code integer,
  callback_status text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz
);

create unique index if not exists payment_attempts_one_active_per_order
  on public.payment_attempts(order_id)
  where status in ('creating','pending');

create index if not exists payment_attempts_order_created_idx
  on public.payment_attempts(order_id, created_at desc);

alter table public.payment_attempts enable row level security;
revoke all on table public.payment_attempts from public, anon, authenticated;
grant select, insert, update on table public.payment_attempts to service_role;

create or replace function public.begin_product_payment(
  p_order_id bigint,
  p_idempotency_key uuid
)
returns table (
  attempt_id uuid,
  amount_toman bigint,
  attempt_status text,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_attempt public.payment_attempts%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_order_id is null or p_idempotency_key is null then
    raise exception 'invalid payment request';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;
  if v_order.payment_status <> 'unpaid' or v_order.status = 'cancelled' then
    raise exception 'order is not payable';
  end if;
  if v_order.subtotal is null or v_order.subtotal <= 0 then
    raise exception 'order amount is not payable';
  end if;

  select * into v_attempt
  from public.payment_attempts
  where idempotency_key = p_idempotency_key;

  if found then
    if v_attempt.order_id <> p_order_id then
      raise exception 'idempotency key conflict';
    end if;
    return query select v_attempt.id, v_attempt.amount_toman, v_attempt.status, true;
    return;
  end if;

  select * into v_attempt
  from public.payment_attempts
  where order_id = p_order_id and status in ('creating','pending')
  order by created_at desc
  limit 1;

  if found then
    return query select v_attempt.id, v_attempt.amount_toman, v_attempt.status, true;
    return;
  end if;

  insert into public.payment_attempts(order_id, idempotency_key, amount_toman)
  values (p_order_id, p_idempotency_key, v_order.subtotal)
  returning * into v_attempt;

  return query select v_attempt.id, v_attempt.amount_toman, v_attempt.status, false;
end;
$$;

create or replace function public.set_product_payment_authority(
  p_attempt_id uuid,
  p_authority text,
  p_request_code integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_attempt_id is null or nullif(trim(p_authority), '') is null then
    raise exception 'invalid authority';
  end if;

  update public.payment_attempts
  set authority = p_authority,
      request_code = p_request_code,
      status = 'pending',
      updated_at = now()
  where id = p_attempt_id
    and status = 'creating'
    and authority is null;

  if found then return true; end if;

  return exists (
    select 1 from public.payment_attempts
    where id = p_attempt_id and authority = p_authority and status = 'pending'
  );
end;
$$;

create or replace function public.fail_product_payment_attempt(
  p_attempt_id uuid,
  p_error_message text,
  p_request_code integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  update public.payment_attempts
  set status = 'failed',
      error_message = left(coalesce(p_error_message, 'payment request failed'), 500),
      request_code = p_request_code,
      updated_at = now()
  where id = p_attempt_id and status = 'creating';

  return found;
end;
$$;

create or replace function public.complete_product_payment(
  p_authority text,
  p_ref_id text,
  p_verify_code integer,
  p_callback_status text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payment_attempts%rowtype;
  v_order_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if nullif(trim(p_authority), '') is null then
    raise exception 'invalid authority';
  end if;

  select * into v_attempt
  from public.payment_attempts
  where authority = p_authority
  for update;

  if not found then
    raise exception 'payment attempt not found';
  end if;

  if v_attempt.status = 'verified' then
    return v_attempt.order_id;
  end if;
  if v_attempt.status <> 'pending' then
    raise exception 'payment attempt is not pending';
  end if;

  update public.payment_attempts
  set status = 'verified',
      ref_id = p_ref_id,
      verify_code = p_verify_code,
      callback_status = left(coalesce(p_callback_status, ''), 30),
      verified_at = now(),
      updated_at = now()
  where id = v_attempt.id;

  update public.orders
  set payment_status = 'paid'
  where id = v_attempt.order_id
    and payment_status = 'unpaid'
    and subtotal = v_attempt.amount_toman
    and status <> 'cancelled'
  returning id into v_order_id;

  if v_order_id is null then
    raise exception 'order state or amount changed; manual reconciliation required';
  end if;

  return v_order_id;
end;
$$;

revoke all on function public.begin_product_payment(bigint, uuid) from public, anon, authenticated;
revoke all on function public.set_product_payment_authority(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.fail_product_payment_attempt(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_product_payment(text, text, integer, text) from public, anon, authenticated;

grant execute on function public.begin_product_payment(bigint, uuid) to service_role;
grant execute on function public.set_product_payment_authority(uuid, text, integer) to service_role;
grant execute on function public.fail_product_payment_attempt(uuid, text, integer) to service_role;
grant execute on function public.complete_product_payment(text, text, integer, text) to service_role;

commit;
