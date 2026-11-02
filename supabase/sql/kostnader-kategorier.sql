-- Nye kategorier for kostnader på driftssiden: Sveve, Claude, Domene og Annen kostnad.
-- Kjøres én gang i Supabase: SQL Editor → lim inn alt → Run.
-- Kostnader som var lagt inn som «Trykk av materiell» blir «Annen kostnad». Typen kan byttes på driftssiden etterpå.
alter table public.okonomi drop constraint if exists okonomi_type_check;
update public.okonomi set type = 'annet' where type = 'trykk';
alter table public.okonomi add constraint okonomi_type_check
  check (type in ('sveve', 'claude', 'domene', 'annet', 'gave', 'sponsor', 'stotte', 'annen_inntekt'));
