-- Anonym statistikk etter ett år (beslutning Heidi 10.11.2026).
-- Etter 365 dager tømmer glemmekassen-sms bilde, sted, kart og kode, men raden blir liggende
-- med gjenstand, farge, kommune, bydel, created_at og hentet_at.
--
-- Kjøres én gang i Supabase: SQL Editor → lim inn alt → Run.
-- MÅ kjøres FØR den nye glemmekassen-sms publiseres (ellers feiler lagringen av nye funn).
-- Trygt å kjøre flere ganger (gjør ingenting hvis kolonnene finnes fra før).

alter table public.glemmekassen_shortlink_test
  add column if not exists kommune text,               -- f.eks. «Bærum» eller «Oslo»
  add column if not exists bydel text,                 -- f.eks. «Nordre Aker» (bare der OpenStreetMap har bydel)
  add column if not exists anonymisert_at timestamptz; -- når bilde, sted, kart og kode ble slettet

-- Koden blir null når funnet tømmes. Den unike indeksen glemmekassen_kode_unik tillater
-- mange rader med null (vanlig oppførsel i Postgres), så den trenger ingen endring.

-- Gjør oppryddingen rask: finner funn som ikke er tømt ennå
create index if not exists glemmekassen_ikke_anonymisert
  on public.glemmekassen_shortlink_test (created_at)
  where anonymisert_at is null;
