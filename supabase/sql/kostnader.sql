-- Kostnader og inntekter til driftssiden (glemmekassen.com/drift → fanen «Kostnader»).
-- Kjøres én gang i Supabase: SQL Editor → lim inn alt → Run.
-- Bare serverfunksjonen glemmekassen-drift (service-nøkkel) kan lese og skrive tabellene.

-- 1) Kostnader og inntekter teamet legger inn selv
--    Kostnader: claude (Claude til koding), trykk, domene, annet
--    Inntekter: gave (f.eks. Vipps), sponsor, stotte (f.eks. kommune eller FAU), annen_inntekt
create table if not exists public.okonomi (
  id uuid primary key default gen_random_uuid(),
  dato date not null,
  hva text not null check (char_length(hva) between 1 and 80),
  type text not null check (type in ('claude', 'trykk', 'domene', 'annet', 'gave', 'sponsor', 'stotte', 'annen_inntekt')),
  belop numeric(10, 2) not null check (belop > 0 and belop <= 1000000),
  created_at timestamptz not null default now()
);
alter table public.okonomi enable row level security;

-- 2) Antall SMS og antall som kom hjem, per måned (norsk tid).
--    Funnene slettes etter 365 dager. Denne tabellen tar vare på tallene,
--    så kostnadene for gamle måneder ikke forsvinner fra driftssiden.
create table if not exists public.sms_per_maaned (
  maaned text primary key check (maaned ~ '^[0-9]{4}-[0-9]{2}$'),
  sms integer not null default 0,
  hjem integer not null default 0
);
alter table public.sms_per_maaned enable row level security;
