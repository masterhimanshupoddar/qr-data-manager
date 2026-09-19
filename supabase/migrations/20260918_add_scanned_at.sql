-- Upgrade an existing QR Data Manager installation. Run this whole file in
-- Supabase SQL Editor as postgres. For a new project, run ../schema.sql instead.
-- Existing qr_data and updated_at are preserved exactly. An old capture instant
-- cannot be recovered: legacy records keep scanned_at NULL and must be rescanned.
begin;

alter table public.qr_state
  add column if not exists scanned_at timestamptz;

alter table public.qr_state
  drop constraint if exists qr_state_scan_requires_data;
alter table public.qr_state
  add constraint qr_state_scan_requires_data check (
    scanned_at is null
    or (qr_data is not null and pg_catalog.isfinite(scanned_at))
  );

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

-- No data UPDATE or backfill occurs here. The timestamp trigger sets updated_at
-- on subsequent client saves and rejects changed QR text with a stale capture.
-- Browser clients must PATCH qr_data and the captured scanned_at together.
notify pgrst, 'reload schema';
commit;
