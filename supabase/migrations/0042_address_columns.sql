-- Corridor — 0042 postal addresses as columns (ISSUE-010)
--
-- Why columns, not a table: an address is one-to-one with its owner row
-- (CONTRIBUTING → Schema design #2) and the application reads its parts by
-- name (#4: jsonb is for provider payloads, not named fields). The four jsonb
-- address columns — partners.address (0002), shipments.delivery_address
-- (0019), drivers.us_address (0020), organizations.billing_address (0025) —
-- become six text columns each. The API/UI shape { line1, line2, city,
-- region, postalCode, country } is unchanged; @corridor/domain
-- (addressToColumns / addressFromColumns / nestAddress) does the mapping.
--
-- Nothing else references the jsonb columns — no index, policy, trigger,
-- view or SECURITY DEFINER function — so no object is recreated here.
--
-- Backfill: blanks become null; the country is upper-cased and kept only when
-- it is a 2-letter code, so the check can never fail on legacy rows.

-- 1. partners.address → address_*
alter table public.partners
  add column address_line1       text,
  add column address_line2       text,
  add column address_city        text,
  add column address_region      text,
  add column address_postal_code text,
  add column address_country     text
    constraint partners_address_country_check check (address_country ~ '^[A-Z]{2}$');

update public.partners set
  address_line1       = nullif(btrim(address ->> 'line1'), ''),
  address_line2       = nullif(btrim(address ->> 'line2'), ''),
  address_city        = nullif(btrim(address ->> 'city'), ''),
  address_region      = nullif(btrim(address ->> 'region'), ''),
  address_postal_code = nullif(btrim(address ->> 'postalCode'), ''),
  address_country     = case when upper(btrim(address ->> 'country')) ~ '^[A-Z]{2}$'
                             then upper(btrim(address ->> 'country')) end;

alter table public.partners drop column address;

-- 2. shipments.delivery_address → delivery_*
alter table public.shipments
  add column delivery_line1       text,
  add column delivery_line2       text,
  add column delivery_city        text,
  add column delivery_region      text,
  add column delivery_postal_code text,
  add column delivery_country     text
    constraint shipments_delivery_country_check check (delivery_country ~ '^[A-Z]{2}$');

update public.shipments set
  delivery_line1       = nullif(btrim(delivery_address ->> 'line1'), ''),
  delivery_line2       = nullif(btrim(delivery_address ->> 'line2'), ''),
  delivery_city        = nullif(btrim(delivery_address ->> 'city'), ''),
  delivery_region      = nullif(btrim(delivery_address ->> 'region'), ''),
  delivery_postal_code = nullif(btrim(delivery_address ->> 'postalCode'), ''),
  delivery_country     = case when upper(btrim(delivery_address ->> 'country')) ~ '^[A-Z]{2}$'
                              then upper(btrim(delivery_address ->> 'country')) end;

alter table public.shipments drop column delivery_address;

-- 3. organizations.billing_address → billing_*
alter table public.organizations
  add column billing_line1       text,
  add column billing_line2       text,
  add column billing_city        text,
  add column billing_region      text,
  add column billing_postal_code text,
  add column billing_country     text
    constraint organizations_billing_country_check check (billing_country ~ '^[A-Z]{2}$');

update public.organizations set
  billing_line1       = nullif(btrim(billing_address ->> 'line1'), ''),
  billing_line2       = nullif(btrim(billing_address ->> 'line2'), ''),
  billing_city        = nullif(btrim(billing_address ->> 'city'), ''),
  billing_region      = nullif(btrim(billing_address ->> 'region'), ''),
  billing_postal_code = nullif(btrim(billing_address ->> 'postalCode'), ''),
  billing_country     = case when upper(btrim(billing_address ->> 'country')) ~ '^[A-Z]{2}$'
                             then upper(btrim(billing_address ->> 'country')) end;

alter table public.organizations drop column billing_address;

-- 4. drivers.us_address → us_address_*
alter table public.drivers
  add column us_address_line1       text,
  add column us_address_line2       text,
  add column us_address_city        text,
  add column us_address_region      text,
  add column us_address_postal_code text,
  add column us_address_country     text
    constraint drivers_us_address_country_check check (us_address_country ~ '^[A-Z]{2}$');

update public.drivers set
  us_address_line1       = nullif(btrim(us_address ->> 'line1'), ''),
  us_address_line2       = nullif(btrim(us_address ->> 'line2'), ''),
  us_address_city        = nullif(btrim(us_address ->> 'city'), ''),
  us_address_region      = nullif(btrim(us_address ->> 'region'), ''),
  us_address_postal_code = nullif(btrim(us_address ->> 'postalCode'), ''),
  us_address_country     = case when upper(btrim(us_address ->> 'country')) ~ '^[A-Z]{2}$'
                                then upper(btrim(us_address ->> 'country')) end;

alter table public.drivers drop column us_address;
