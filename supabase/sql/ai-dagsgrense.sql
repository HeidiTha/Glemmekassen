-- Teller kall til Claude per døgn, så claude-proxy kan stoppe ved en fast grense.
-- Bare serverfunksjonene (service-nøkkel) kan bruke dette.
create table if not exists public.ai_bruk (
  dag date primary key,
  antall integer not null default 0
);
alter table public.ai_bruk enable row level security;

-- Øker dagens teller med 1 og svarer true hvis vi fortsatt er innenfor grensen
create or replace function public.registrer_ai_kall(maks integer)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.ai_bruk (dag, antall) values (current_date, 1)
  on conflict (dag) do update set antall = public.ai_bruk.antall + 1
  returning antall <= maks;
$$;
revoke execute on function public.registrer_ai_kall(integer) from public, anon, authenticated;
