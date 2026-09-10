-- Corridor — 0040 add missing equipment_types code FN
--
-- Why not a new table: equipment_types (0021) is the CBP/CBSA equipment
-- description code lookup; ACE Appendix N includes FN ("Flat bed trailer,
-- no headboards") alongside the FT/FH/FR flatbed variants already seeded.
-- It surfaced as a gap while reconciling a live carrier's Avaal trailer
-- fleet against Corridor — one of their trailers is filed under FN and the
-- code was missing from the 0021 seed list.

insert into public.equipment_types (code, label, regime_scope) values
  ('FN', 'Flat bed trailer, no headboards', 'both')
on conflict (code) do nothing;
