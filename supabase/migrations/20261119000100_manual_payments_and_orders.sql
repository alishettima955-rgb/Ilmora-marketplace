-- Ilmora manual UBA / OPay checkout, guest orders and payment review
alter table public.orders drop constraint if exists orders_gateway_check;
alter table public.orders add constraint orders_gateway_check
  check (gateway = any (array['paystack','flutterwave','bank_transfer','opay']));

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status = any (array['pending','awaiting_review','paid','failed']));

alter table public.payment_references drop constraint if exists payment_references_method_check;
alter table public.payment_references add constraint payment_references_method_check
  check (method = any (array['bank_transfer','opay','card','open_banking']));

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method = any (array['bank_transfer','opay','card','open_banking','manual_adjustment']));

alter table public.order_items add column if not exists quantity integer not null default 1;
alter table public.order_items drop constraint if exists order_items_quantity_check;
alter table public.order_items add constraint order_items_quantity_check check (quantity between 1 and 5);

create unique index if not exists payments_one_review_per_order_idx
  on public.payments(order_id) where status='awaiting_review';

drop policy if exists "Admins manage orders" on public.orders;
create policy "Admins manage orders" on public.orders
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create or replace function public.ilmora_admin_review_payment(
  p_payment_id uuid, p_actor_id uuid, p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_payment public.payments%rowtype;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id=p_actor_id
      and p.role='admin'
      and lower(p.email)='umaraliibrahim36@gmail.com'
  ) then
    raise exception 'Administrator permission required';
  end if;

  select * into v_payment
  from public.payments
  where id=p_payment_id
  for update;

  if not found or v_payment.status <> 'awaiting_review' then
    raise exception 'Payment is not awaiting review';
  end if;

  update public.payments
  set status=case when p_approve then 'verified' else 'failed' end,
      verified_at=case when p_approve then now() else null end,
      verified_by=case when p_approve then p_actor_id else null end,
      updated_at=now()
  where id=p_payment_id;

  update public.orders
  set status=case when p_approve then 'paid' else 'failed' end
  where id=v_payment.order_id and status='awaiting_review';

  if not found then raise exception 'Order is not awaiting review'; end if;

  update public.payment_references
  set status=case when p_approve then 'matched' else 'cancelled' end,
      matched_payment_id=case when p_approve then p_payment_id else null end
  where order_id=v_payment.order_id;
end;
$$;

revoke all on function public.ilmora_admin_review_payment(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.ilmora_admin_review_payment(uuid,uuid,boolean)
  to service_role;
