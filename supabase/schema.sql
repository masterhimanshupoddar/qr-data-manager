-- Run the entire file in your Supabase project's SQL Editor as postgres.
-- Creates a new installation or upgrades an existing one without replacing data.
begin;

create table if not exists public.qr_state (
  id smallint primary key default 1,
  qr_data text,
  updated_at timestamptz,
  scanned_at timestamptz,
  constraint qr_state_singleton check (id = 1),
  constraint qr_state_valid_text check (
    qr_data is null or (
      length(qr_data) > 0
      and octet_length(convert_to(qr_data, 'UTF8')) <= 8192
    )
  )
);

-- Existing records remain untouched. Their original capture time is unknown;
-- leave scanned_at NULL and require a fresh scan instead of inventing a value.
alter table public.qr_state
  add column if not exists scanned_at timestamptz;
alter table public.qr_state
  drop constraint if exists qr_state_scan_requires_data;
alter table public.qr_state
  add constraint qr_state_scan_requires_data check (
    scanned_at is null
    or (qr_data is not null and pg_catalog.isfinite(scanned_at))
  );

-- NULL represents "nothing scanned yet". Never replace existing QR contents.
insert into public.qr_state (id, qr_data, updated_at, scanned_at)
values (1, null, null, null)
on conflict (id) do nothing;

create or replace function public.set_qr_state_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.qr_data is distinct from old.qr_data
     and new.scanned_at is not distinct from old.scanned_at then
    raise exception using
      errcode = '23514',
      message = 'Changed QR text requires its actual new capture time. Scan the QR again.';
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function public.set_qr_state_updated_at()
from public, anon, authenticated;

drop trigger if exists qr_state_updated_at on public.qr_state;
create trigger qr_state_updated_at
before update on public.qr_state
for each row execute function public.set_qr_state_updated_at();

alter table public.qr_state enable row level security;

-- Each scan stores its text and actual device capture instant in one PATCH.
-- updated_at is a separate server save timestamp; browsers cannot set it or id.
revoke all on table public.qr_state from public, anon, authenticated;
revoke all (id, qr_data, updated_at, scanned_at) on public.qr_state
from public, anon, authenticated;
grant usage on schema public to anon;
grant select on table public.qr_state to anon;
grant update (qr_data, scanned_at) on public.qr_state to anon;

drop policy if exists qr_state_public_read on public.qr_state;
create policy qr_state_public_read
on public.qr_state for select
to anon
using (id = 1);

drop policy if exists qr_state_public_update on public.qr_state;
create policy qr_state_public_update
on public.qr_state for update
to anon
using (id = 1)
with check (
  id = 1
  and qr_data is not null
  and scanned_at is not null
  and pg_catalog.isfinite(scanned_at)
);

-- No browser INSERT or DELETE grants/policies. The seeded row is the only row.
-- Anyone with the public endpoint/key can read and overwrite its contents.
notify pgrst, 'reload schema';
commit;
