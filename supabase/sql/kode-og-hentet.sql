-- Kode i SMS-en i stedet for lang lenke, og «Jeg har hentet den» på eiersiden.
-- Kjøres én gang i Supabase: SQL Editor → lim inn alt → Run.
-- Trygt å kjøre flere ganger (gjør ingenting hvis kolonnene finnes fra før).

alter table public.glemmekassen_shortlink_test
  add column if not exists kode text,        -- 6 tegn, f.eks. K7M4Q2 – står i SMS-en
  add column if not exists farge text,       -- f.eks. «blå», vises på eiersiden
  add column if not exists hentet_at timestamptz; -- når eieren trykket «Jeg har hentet den»

-- Hver kode skal bare finnes én gang
create unique index if not exists glemmekassen_kode_unik
  on public.glemmekassen_shortlink_test (kode);
