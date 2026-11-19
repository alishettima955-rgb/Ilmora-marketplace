create table if not exists public.product_folders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.product_files
  add column if not exists folder_id uuid references public.product_folders(id) on delete set null;

create index if not exists product_folders_product_sort_idx
  on public.product_folders(product_id, sort_order, created_at);

create index if not exists product_files_folder_idx
  on public.product_files(folder_id);

alter table public.product_folders enable row level security;

grant select, insert, update, delete on public.product_folders to authenticated;

drop policy if exists "Admin manage product folders" on public.product_folders;
create policy "Admin manage product folders"
  on public.product_folders for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Buyer access paid product folders" on public.product_folders;
create policy "Buyer access paid product folders"
  on public.product_folders for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.product_id = product_folders.product_id
        and o.user_id = (select auth.uid())
        and o.status = 'paid'
    )
  );
