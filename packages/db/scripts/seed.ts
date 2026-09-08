/**
 * Idempotent dev seed: applies supabase/seed.sql (permissions + system roles)
 * then creates a demo organization with a few users via the Supabase admin API.
 *
 *   pnpm db:seed
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DIRECT_DATABASE_URL
 * (all provided by `supabase start` locally).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { SYSTEM_ROLES } from "@corridor/domain";
import { ingestRegulations } from "@corridor/ai";

const here = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL =
  process.env.DIRECT_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required (see `supabase status`)");
  process.exit(1);
}

/** What `postgres`'s `sql.json()` accepts. */
type Json = Parameters<ReturnType<typeof postgres>["json"]>[0];

export const DEMO_ORG = {
  name: "Pathfinder Trans Inc",
  legalName: "PATHFINDER TRANS INC",
  scacCode: "PFTR",
  canadianCarrierCode: "7ELU",
  usDotNumber: "1234567",
  mcNumber: "MC-987654",
} as const;

export const DEMO_USERS = [
  {
    email: "owner@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.owner,
    name: "Harjit Owner",
  },
  {
    email: "dispatch@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.dispatcher,
    name: "Dana Dispatcher",
  },
  {
    email: "compliance@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.compliance_officer,
    name: "Chris Compliance",
  },
  {
    email: "readonly@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.read_only,
    name: "Riley Readonly",
  },
  {
    email: "driver@pathfinder.demo",
    password: "corridor-demo",
    role: SYSTEM_ROLES.driver_portal,
    name: "Gurpreet Singh",
  },
] as const;

/** A second, unrelated org used by cross-tenant-leak tests. */
export const OTHER_ORG = { name: "Northbound Freight Ltd", scacCode: "NBFL" } as const;
export const OTHER_USER = {
  email: "owner@northbound.demo",
  password: "corridor-demo",
  role: SYSTEM_ROLES.owner,
  name: "Nora Northbound",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any, any, any>;

async function ensureUser(
  admin: AdminClient,
  u: { email: string; password: string; name: string },
) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existing = list?.users.find((x) => x.email === u.email);
  if (existing) return existing.id;
  const { data, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: u.password,
    email_confirm: true,
    user_metadata: { display_name: u.name },
  });
  if (error) throw error;
  return data.user.id;
}

export async function seed() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const sql = postgres(DB_URL, { max: 1 });

  try {
    // 1. catalogue + system roles
    const seedSql = readFileSync(resolve(here, "../../../supabase/seed.sql"), "utf8");
    await sql.unsafe(seedSql);

    // 2. demo org + users
    const roles = await sql<{ id: string; name: string }[]>`
      select id, name from public.roles where is_system`;
    const roleId = (name: string) => {
      const r = roles.find((x) => x.name === name);
      if (!r) throw new Error(`system role ${name} missing`);
      return r.id;
    };

    // organizations.name has no unique constraint (two real tenants may share a
    // display name), so re-seeding without a full `db reset` must check first —
    // an ON CONFLICT clause here would never trigger and silently double-insert.
    async function ensureOrg(org: { name: string; [k: string]: string }) {
      const [existing] = await sql<{ id: string }[]>`
        select id from public.organizations where name = ${org.name} limit 1`;
      if (existing) return existing.id;
      const [row] = await sql<{ id: string }[]>`
        insert into public.organizations (name, legal_name, scac_code, canadian_carrier_code, us_dot_number, mc_number)
        values (${org.name}, ${org.legalName ?? null}, ${org.scacCode ?? null},
                ${org.canadianCarrierCode ?? null}, ${org.usDotNumber ?? null}, ${org.mcNumber ?? null})
        returning id`;
      return row!.id;
    }

    const orgId = await ensureOrg(DEMO_ORG);
    const demoUserIds = new Map<string, string>();
    for (const u of DEMO_USERS) {
      const userId = await ensureUser(admin, u);
      demoUserIds.set(u.email, userId);
      await sql`
        insert into public.organization_members (organization_id, user_id, role_id, status)
        values (${orgId}, ${userId}, ${roleId(u.role)}, 'active')
        on conflict (organization_id, user_id) where user_id is not null
        do update set role_id = excluded.role_id, status = 'active'`;
    }

    const otherOrgId = await ensureOrg(OTHER_ORG);
    const otherUserId = await ensureUser(admin, OTHER_USER);
    await sql`
      insert into public.organization_members (organization_id, user_id, role_id, status)
      values (${otherOrgId}, ${otherUserId}, ${roleId(OTHER_USER.role)}, 'active')
      on conflict (organization_id, user_id) where user_id is not null
      do update set role_id = excluded.role_id, status = 'active'`;

    // 2b. multi-carrier codes (0018): the demo org files under two ACE codes
    // (a co-loaded second unit) and one ACI code; Northbound files under one.
    await sql`
      insert into public.organization_carrier_codes (organization_id, regime, code, label, is_default)
      values
        (${orgId}, 'ACE', 'PFTR', 'Primary US filing code', true),
        (${orgId}, 'ACE', 'PFTS', 'Secondary US filing code', false),
        (${orgId}, 'ACI', '7ELU', 'Primary CA filing code', true)
      on conflict (organization_id, regime, code) do nothing`;
    await sql`
      insert into public.organization_carrier_codes (organization_id, regime, code, is_default)
      values (${otherOrgId}, 'ACE', 'NBFL', true)
      on conflict (organization_id, regime, code) do nothing`;

    // 3. registries for the demo org — dates relative to today so expiry alerts
    //    demo correctly no matter when the seed runs.
    const day = (offset: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };

    // partners has no natural unique key (a company name isn't guaranteed
    // unique), so — unlike drivers/trucks/trailers, which have real unique
    // constraints — `on conflict do nothing` can't dedupe it on a reseed
    // against an existing org. Gate the whole registries block on that.
    const partnerCountRows = await sql<{ existing: number }[]>`
      select count(*)::int as existing from public.partners where organization_id = ${orgId}`;
    if ((partnerCountRows[0]?.existing ?? 0) === 0) {
      await sql`
        insert into public.drivers (organization_id, first_name, last_name, person_type, gender,
          license_number, license_jurisdiction, license_expiry, medical_cert_expiry, citizenship,
          hazmat_endorsement, us_address, phone, email)
        values
          (${orgId}, 'Gurpreet', 'Singh',   'driver',    'M', 'S1234-56789-01234', 'ON', ${day(400)}, ${day(200)}, 'CA', true,  ${sql.json({})}, '+1 905 555 0101', 'gurpreet@pathfinder.demo'),
          (${orgId}, 'Marcus',   'Reyes',   'driver',    'M', 'R7788-11223-33445', 'MI', ${day(9)},   ${day(300)}, 'US', false, ${sql.json({})}, '+1 313 555 0102', 'marcus@pathfinder.demo'),
          (${orgId}, 'Amrit',    'Kaur',    'driver',    'F', 'K5566-99887-77665', 'BC', ${day(-12)}, null,        'CA', false, ${sql.json({})}, '+1 604 555 0103', 'amrit@pathfinder.demo'),
          (${orgId}, 'Dale',     'Thompson','driver',    'M', 'T1010-20203-30304', 'NY', ${day(700)}, ${day(650)}, 'US', false, ${sql.json({})}, '+1 716 555 0104', 'dale@pathfinder.demo'),
          -- A passenger rides along and never drives: no licence, a travel
          -- document instead, and a US address for the ACE crew list.
          (${orgId}, 'Rosa',     'Delgado', 'passenger', 'F', null,                null, null,        null,        'MX', false,
            ${sql.json({ line1: "2200 Michigan Ave", city: "Detroit", region: "MI", postalCode: "48216", country: "US" })},
            '+1 313 555 0105', 'rosa@pathfinder.demo')
        on conflict do nothing`;

      // Travel documents (0020): the FAST cards that used to be columns on
      // `drivers`, plus the passports the crew actually presents at the booth.
      await sql`
        insert into public.driver_documents (organization_id, driver_id, document_type, document_number,
          issuing_country, issued_on, expires_on, is_primary)
        select ${orgId}, d.id, x.document_type, x.document_number, x.issuing_country,
               x.issued_on::date, x.expires_on::date, x.is_primary
        from (values
          ('Singh',   'fast',     'FAST-88123', 'CA', ${day(-1200)}, ${day(45)},   false),
          ('Singh',   'passport', 'HA412355',   'CA', ${day(-1500)}, ${day(1500)}, true),
          ('Reyes',   'passport', 'US8871220',  'US', ${day(-900)},  ${day(120)},  true),
          ('Reyes',   'fast',     'FAST-77014', 'US', ${day(-600)},  ${day(900)},  false),
          ('Kaur',    'fast',     'FAST-90455', 'CA', ${day(-800)},  ${day(500)},  false),
          ('Delgado', 'laser_visa_bcc', 'BCC-4471902', 'MX', ${day(-400)}, ${day(1100)}, true)
        ) as x(last_name, document_type, document_number, issuing_country, issued_on, expires_on, is_primary)
        join public.drivers d
          on d.organization_id = ${orgId} and d.last_name = x.last_name
        on conflict do nothing`;

      await sql`
        insert into public.trucks (organization_id, unit_number, vin, make, model, model_year, plate_number, plate_jurisdiction,
          registration_expiry, insurance_policy_number, insurance_expiry, annual_inspection_expiry, transponder_number,
          dot_number, hazmat_capable, insurance_company, insurance_amount, insurance_year)
        values
          (${orgId}, 'T-101', '1FUJGLDR5CSBP8834', 'Freightliner', 'Cascadia', 2022, 'AB12345', 'ON', ${day(300)}, 'POL-77812', ${day(20)},  ${day(90)},  'TX-100001', '1234567', true,  'Northbridge Insurance', 2000000, 2026),
          (${orgId}, 'T-102', '1XKYDP9X5PJ456789', 'Kenworth',     'T680',     2023, 'CD67890', 'ON', ${day(-3)},  'POL-77812', ${day(250)}, ${day(-40)}, 'TX-100002', '1234567', false, 'Northbridge Insurance', 2000000, 2026),
          (${orgId}, 'T-103', '3AKJHHDR8LSMD1234', 'Freightliner', 'Cascadia', 2020, 'EF11223', 'MI', ${day(500)}, 'POL-77813', ${day(400)}, ${day(30)},  null,        '1234567', false, 'Intact Insurance',     1000000, 2025)
        on conflict do nothing`;

      await sql`
        insert into public.trailers (organization_id, unit_number, vin, trailer_type, plate_number, plate_jurisdiction,
          registration_expiry, insurance_expiry, annual_inspection_expiry, length_ft)
        values
          (${orgId}, 'TR-501', '1UYVS2538PU123456', 'TF', 'TRL5011', 'ON', ${day(180)}, ${day(180)}, ${day(55)},  53),
          (${orgId}, 'TR-502', '1UYVS2538PU654321', 'RT', 'TRL5022', 'ON', ${day(10)},  ${day(365)}, ${day(365)}, 53),
          (${orgId}, 'TR-503', null,                'FT', 'TRL5033', 'MI', ${day(600)}, ${day(600)}, null,        48)
        on conflict do nothing`;

      // Extra plates (equipment_plates, 0021): T-101 and TR-501 are also
      // registered in Michigan for the Detroit lane.
      await sql`
        insert into public.equipment_plates (organization_id, truck_id, trailer_id, plate_number, jurisdiction, position)
        select ${orgId}, t.id, null, 'AB12345M', 'MI', 1
        from public.trucks t where t.organization_id = ${orgId} and t.unit_number = 'T-101'
          and not exists (select 1 from public.equipment_plates p where p.truck_id = t.id)`;
      await sql`
        insert into public.equipment_plates (organization_id, truck_id, trailer_id, plate_number, jurisdiction, position)
        select ${orgId}, null, t.id, 'TRL5011M', 'MI', 1
        from public.trailers t where t.organization_id = ${orgId} and t.unit_number = 'TR-501'
          and not exists (select 1 from public.equipment_plates p where p.trailer_id = t.id)`;

      await sql`
        insert into public.partners (organization_id, name, type, address, tax_id, contact_name, contact_email, contact_phone)
        values
          (${orgId}, 'Maple Ridge Steel Ltd', 'shipper',
            ${sql.json({ line1: "400 Industrial Pkwy", city: "Hamilton", region: "ON", postalCode: "L8E 2W1", country: "CA" })},
            '123456789RT0001', 'Lena Park', 'lpark@mapleridgesteel.example', '+1 905 555 0201'),
          (${orgId}, 'Great Lakes Fabrication Inc', 'consignee',
            ${sql.json({ line1: "1200 Ford Rd", city: "Dearborn", region: "MI", postalCode: "48126", country: "US" })},
            '38-1234567', 'Omar Haddad', 'ohaddad@glfab.example', '+1 313 555 0202'),
          (${orgId}, 'Northgate Customs Brokers', 'broker',
            ${sql.json({ line1: "55 Bridge St", city: "Fort Erie", region: "ON", postalCode: "L2A 1T2", country: "CA" })},
            null, 'Priya Nair', 'pnair@northgatecb.example', '+1 905 555 0203'),
          (${orgId}, 'Erie Produce Co', 'both',
            ${sql.json({ line1: "88 Market Ave", city: "Buffalo", region: "NY", postalCode: "14203", country: "US" })},
            '16-7654321', 'Sam Okafor', 'sam@erieproduce.example', '+1 716 555 0204')
        on conflict do nothing`;
    }

    await sql`
      update public.drivers
      set user_id = ${demoUserIds.get("driver@pathfinder.demo")!}
      where organization_id = ${orgId} and email = 'gurpreet@pathfinder.demo'`;

    // The other org gets one driver so cross-tenant tests have a row to *not* see.
    await sql`
      insert into public.drivers (organization_id, first_name, last_name, license_number, license_jurisdiction, license_expiry)
      values (${otherOrgId}, 'Nora', 'Bergstrom', 'B9999-00000-11111', 'BC', ${day(365)})
      on conflict do nothing`;

    // Singh gets entry numbers by text (0025); two demo dispatch inboxes.
    await sql`
      update public.drivers set sms_opt_in = true, sms_phone_ace = '+1 905 555 0101', sms_phone_aci = '+1 905 555 0101'
      where organization_id = ${orgId} and last_name = 'Singh'`;
    await sql`
      update public.organizations
      set dispatch_emails = array['dispatch@pathfinder.demo', 'ops@pathfinder.demo'],
          timezone = 'America/Toronto',
          billing_address = ${sql.json({ line1: "1 Corridor Way", city: "Mississauga", region: "ON", postalCode: "L5T 2M8", country: "CA" })}
      where id = ${orgId} and cardinality(dispatch_emails) = 0`;

    // 3b. integration configs — sandbox mock gateways with a short decision delay
    await sql`
      insert into public.integration_configs (organization_id, provider, environment, settings)
      values
        (${orgId}, 'cbp_ace',  'sandbox', ${sql.json({ mockDelayMs: 3000, mockFailureRate: 0 })}),
        (${orgId}, 'cbsa_aci', 'sandbox', ${sql.json({ mockDelayMs: 3000, mockFailureRate: 0 })})
      on conflict (organization_id, provider) do nothing`;

    // 4. movements spanning every status. Children are inserted while draft
    //    (edit-lock trigger), then the status is walked through VALID transitions
    //    so the DB state machine + timeline are exercised exactly like production.
    const existingRows = await sql<{ existing: number }[]>`
      select count(*)::int as existing from public.movements where organization_id = ${orgId}`;
    if ((existingRows[0]?.existing ?? 0) === 0) {
      const ids = async (table: string, col: string, val: string) =>
        (
          await sql<
            { id: string }[]
          >`select id from ${sql(table)} where organization_id = ${orgId} and ${sql(col)} = ${val} limit 1`
        )[0]!.id;
      const dispatcherId = (
        await sql<
          { id: string }[]
        >`select id from auth.users where email = 'dispatch@pathfinder.demo'`
      )[0]!.id;
      const gurpreet = await ids("drivers", "last_name", "Singh");
      const marcus = await ids("drivers", "last_name", "Reyes");
      const dale = await ids("drivers", "last_name", "Thompson");
      const rosa = await ids("drivers", "last_name", "Delgado");
      const t101 = await ids("trucks", "unit_number", "T-101");
      const t103 = await ids("trucks", "unit_number", "T-103");
      const tr501 = await ids("trailers", "unit_number", "TR-501");
      const tr502 = await ids("trailers", "unit_number", "TR-502");
      const tr503 = await ids("trailers", "unit_number", "TR-503");
      const maple = await ids("partners", "name", "Maple Ridge Steel Ltd");
      const glf = await ids("partners", "name", "Great Lakes Fabrication Inc");
      const erie = await ids("partners", "name", "Erie Produce Co");

      /** One shipment plus its commodity lines; `movementId` null = unassigned. */
      const seedShipment = async (spec: {
        regime: "ACE" | "ACI";
        carrierCode: string;
        /** Defaults to the regime's plain filing (ACE regular_bill / ACI regular). */
        type?: string;
        controlReference: string;
        shipper: string;
        consignee: string;
        movementId: string | null;
        isPars?: boolean;
        commodities: Array<{
          desc: string;
          hs: string;
          kg: number;
          qty: number;
          unit: string;
          value: number;
          ccy: "USD" | "CAD";
          origin: string;
        }>;
      }) => {
        const [shipment] = await sql<{ id: string }[]>`
          insert into public.shipments (organization_id, regime, movement_id, carrier_code,
            shipment_type, cargo_type, control_reference, is_pars, shipper_id, consignee_id)
          values (${orgId}, ${spec.regime}, ${spec.movementId}, ${spec.carrierCode},
            ${spec.regime === "ACE" ? (spec.type ?? "regular_bill") : null},
            ${spec.regime === "ACI" ? (spec.type ?? "regular") : null},
            ${spec.controlReference}, ${spec.isPars ?? false}, ${spec.shipper}, ${spec.consignee})
          returning id`;
        let line = 0;
        for (const c of spec.commodities) {
          line++;
          await sql`
            insert into public.commodities (shipment_id, organization_id, line_number, commodity_description,
              hs_code, weight_kg, weight_unit, quantity, quantity_unit, packaging_type, value_amount,
              value_currency, country_of_origin)
            values (${shipment!.id}, ${orgId}, ${line}, ${c.desc}, ${c.hs}, ${c.kg}, 'KG', ${c.qty},
              ${c.unit}, 'pallet', ${c.value}, ${c.ccy}, ${c.origin})`;
        }
        return shipment!.id;
      };

      const CUSTOMS_DRIVEN = new Set(["accepted", "rejected", "released", "held"]);
      let seq = 0;
      const seedMovement = async (spec: {
        regime: "ACE" | "ACI";
        /** The person in charge; `alsoCrew` rides along. */
        driver: string;
        alsoCrew?: Array<{ driverId: string; role: "crew_member" | "passenger" }>;
        truck: string;
        /** Trailers in tow order (0021); empty = bobtail. */
        trailers: string[];
        portCode: string;
        etaDays: number;
        shipments: Array<{
          controlReference: string;
          shipper: string;
          consignee: string;
          commodities: Array<{
            desc: string;
            hs: string;
            kg: number;
            qty: number;
            unit: string;
            value: number;
            ccy: "USD" | "CAD";
            origin: string;
          }>;
        }>;
        /** Seal numbers per trailer position (index = tow position); `truck` = a seal on the tractor. */
        seals: string[][];
        truckSeal?: string;
        path: Array<
          "sent" | "accepted" | "rejected" | "released" | "held" | "arrived" | "cancelled"
        >;
        ref?: string;
      }) => {
        seq++;
        const number = `${spec.regime}-${new Date().getUTCFullYear().toString().slice(-2)}-${String(seq).padStart(5, "0")}`;
        const eta = new Date();
        eta.setUTCDate(eta.getUTCDate() + spec.etaDays);
        const carrierCode = spec.regime === "ACE" ? "PFTR" : "7ELU";
        const [port] = await sql<{ id: string }[]>`
          select id from public.ports where regime = ${spec.regime} and code = ${spec.portCode} limit 1`;
        if (!port) throw new Error(`seed: unknown port code ${spec.portCode} for ${spec.regime}`);
        const [m] = await sql<{ id: string }[]>`
          insert into public.movements (organization_id, regime, movement_number, trip_number, port_id, carrier_code,
            scheduled_crossing_at, truck_id, created_by)
          values (${orgId}, ${spec.regime}, ${number}, ${"TRIP-" + String(1000 + seq)}, ${port.id}, ${carrierCode},
            ${eta.toISOString()}, ${spec.truck}, ${dispatcherId})
          returning id`;
        const id = m!.id;
        const slotIds: string[] = [];
        for (const [i, trailerId] of spec.trailers.entries()) {
          const [slot] = await sql<{ id: string }[]>`
            insert into public.movement_trailers (organization_id, movement_id, trailer_id, position)
            values (${orgId}, ${id}, ${trailerId}, ${i + 1})
            returning id`;
          slotIds.push(slot!.id);
        }
        await sql`
          insert into public.movement_crew (organization_id, movement_id, driver_id, role, position)
          values (${orgId}, ${id}, ${spec.driver}, 'person_in_charge', 1)`;
        let crewPosition = 1;
        for (const extra of spec.alsoCrew ?? []) {
          crewPosition++;
          await sql`
            insert into public.movement_crew (organization_id, movement_id, driver_id, role, position)
            values (${orgId}, ${id}, ${extra.driverId}, ${extra.role}, ${crewPosition})`;
        }
        await sql`
          insert into public.movement_events (movement_id, organization_id, event_type, from_status, to_status, actor_type, actor_id, payload)
          values (${id}, ${orgId}, 'status_change', null, 'draft', 'user', ${dispatcherId}, ${sql.json({ movementNumber: number })})`;
        for (const spec_shipment of spec.shipments) {
          await seedShipment({
            ...spec_shipment,
            regime: spec.regime,
            carrierCode,
            movementId: id,
          });
        }
        for (const [i, numbers] of spec.seals.entries()) {
          for (const s of numbers) {
            await sql`
              insert into public.seals (movement_id, organization_id, movement_trailer_id, seal_number, seal_type, applied_by, applied_at)
              values (${id}, ${orgId}, ${slotIds[i] ?? null}, ${s}, 'bolt', 'Yard', now())`;
          }
        }
        if (spec.truckSeal) {
          await sql`
            insert into public.seals (movement_id, organization_id, movement_trailer_id, seal_number, seal_type, applied_by, applied_at)
            values (${id}, ${orgId}, null, ${spec.truckSeal}, 'cable', 'Yard', now())`;
        }
        // A filed movement has the submission the gateway would have
        // acknowledged (customs_submissions, 0023), so the webhook can find it.
        if (spec.ref) {
          await sql`
            insert into public.customs_submissions (organization_id, movement_id, kind, provider, mode,
              reference_number, status, request, response)
            values (${orgId}, ${id}, 'original', ${spec.regime === "ACE" ? "cbp_ace" : "cbsa_aci"}, 'mock',
              ${spec.ref}, ${spec.path.includes("released") ? "released" : spec.path.includes("rejected") ? "rejected" : spec.path.includes("held") ? "held" : "accepted"},
              ${sql.json({ movementNumber: number })}, ${sql.json({ mock: true, acknowledged: true })})`;
        }
        let from = "draft";
        for (const to of spec.path) {
          const customs = CUSTOMS_DRIVEN.has(to);
          if (customs) {
            await sql`
              insert into public.movement_events (movement_id, organization_id, event_type, actor_type, payload)
              values (${id}, ${orgId}, 'customs_response', 'customs_api',
                ${sql.json({ decision: to, referenceNumber: spec.ref ?? null, simulated: true })})`;
          }
          await sql`update public.movements set status = ${to}, customs_reference_number = ${spec.ref ?? null} where id = ${id}`;
          await sql`
            insert into public.movement_events (movement_id, organization_id, event_type, from_status, to_status, actor_type, actor_id)
            values (${id}, ${orgId}, 'status_change', ${from}, ${to}, ${customs ? "customs_api" : "user"},
              ${customs ? null : dispatcherId})`;
          from = to;
        }
        // Shipments ride the movement: their status follows the last step of
        // the path (a released crossing has released shipments, with entries).
        if (from !== "draft") {
          await sql`
            update public.shipments
            set status = ${from},
                entry_number = case when ${from} in ('released','held','arrived')
                  then '300' || lpad((abs(hashtext(control_number)) % 100000000)::text, 8, '0') else null end,
                entry_port_id = case when ${from} in ('released','held','arrived') then ${port.id}::uuid else null end,
                entry_on_file_at = case when ${from} in ('released','held','arrived') then now() else null end,
                released_at = case when ${from} in ('released','arrived') then now() else null end
            where movement_id = ${id}`;
        }
      };

      const DET = "3801"; // Detroit — Ambassador Bridge, MI
      const BUF = "0901"; // Buffalo — Peace Bridge, NY
      const WIN = "0453"; // Windsor — Ambassador Bridge, ON
      const FE = "0410"; // Fort Erie — Peace Bridge, ON
      const steelLine = {
        desc: "Hot-rolled steel coils",
        hs: "7208.10",
        kg: 21500,
        qty: 12,
        unit: "Coil",
        value: 48000,
        ccy: "USD" as const,
        origin: "CA",
      };
      const produceLine = {
        desc: "Fresh apples, bulk bins",
        hs: "0808.10",
        kg: 18200,
        qty: 40,
        unit: "Crate",
        value: 22000,
        ccy: "USD" as const,
        origin: "US",
      };
      const fabLine = {
        desc: "Fabricated steel brackets",
        hs: "7308.90",
        kg: 9800,
        qty: 22,
        unit: "Pallet",
        value: 31000,
        ccy: "CAD" as const,
        origin: "US",
      };

      // ACE bills are PAPS-numbered, ACI ones PARS-numbered.
      let bill = 0;
      const nextRef = (regime: "ACE" | "ACI") =>
        `${regime === "ACE" ? "PAPS" : "PARS"}${String(++bill).padStart(5, "0")}`;
      const steel = (regime: "ACE" | "ACI") => ({
        controlReference: nextRef(regime),
        shipper: maple,
        consignee: glf,
        commodities: [steelLine],
      });
      const produce = (regime: "ACE" | "ACI") => ({
        controlReference: nextRef(regime),
        shipper: erie,
        consignee: erie,
        commodities: [produceLine],
      });
      const fab = (regime: "ACE" | "ACI") => ({
        controlReference: nextRef(regime),
        shipper: glf,
        consignee: maple,
        commodities: [fabLine],
      });

      await seedMovement({
        regime: "ACE",
        driver: gurpreet,
        // Two people in the cab: a second driver and a passenger.
        alsoCrew: [
          { driverId: marcus, role: "crew_member" },
          { driverId: rosa, role: "passenger" },
        ],
        truck: t101,
        // A turnpike double: two trailers, each sealed, plus a cable seal on the tractor.
        trailers: [tr501, tr502],
        portCode: DET,
        etaDays: 2,
        shipments: [steel("ACE")],
        seals: [["SL-100231", "SL-100234"], ["SL-100235"]],
        truckSeal: "SL-100236",
        path: [],
      });
      await seedMovement({
        regime: "ACE",
        driver: dale,
        truck: t103,
        trailers: [tr503],
        portCode: BUF,
        etaDays: 1,
        shipments: [
          {
            ...steel("ACE"),
            commodities: [
              steelLine,
              {
                ...steelLine,
                desc: "Galvanized sheet, coils",
                hs: "7210.49",
                kg: 4000,
                qty: 3,
                unit: "Coil",
                value: 9000,
              },
            ],
          },
        ],
        seals: [["SL-100232"]],
        path: ["sent"],
      });
      await seedMovement({
        regime: "ACE",
        driver: gurpreet,
        truck: t101,
        trailers: [tr501],
        portCode: DET,
        etaDays: 0,
        shipments: [steel("ACE")],
        seals: [["SL-100233"]],
        path: ["sent", "accepted"],
        ref: "ACE-A7K2Q9",
      });
      await seedMovement({
        regime: "ACI",
        driver: dale,
        truck: t103,
        trailers: [tr503],
        portCode: WIN,
        etaDays: 0,
        shipments: [fab("ACI")],
        seals: [["SL-200101"]],
        path: ["sent", "accepted", "released"],
        ref: "ACI-88213Q",
      });
      await seedMovement({
        regime: "ACI",
        driver: marcus,
        truck: t101,
        trailers: [tr501],
        portCode: FE,
        etaDays: 0,
        shipments: [produce("ACI")],
        seals: [["SL-200102"]],
        path: ["sent", "accepted", "held"],
        ref: "ACI-88214H",
      });
      await seedMovement({
        regime: "ACE",
        driver: marcus,
        truck: t103,
        trailers: [tr503],
        portCode: BUF,
        etaDays: 3,
        shipments: [produce("ACE")],
        seals: [[]],
        path: ["sent", "rejected"],
        ref: "ACE-R0011X",
      });
      await seedMovement({
        regime: "ACE",
        driver: gurpreet,
        truck: t101,
        trailers: [tr501],
        portCode: DET,
        etaDays: -3,
        shipments: [steel("ACE")],
        seals: [["SL-100229"]],
        path: ["sent", "accepted", "released", "arrived"],
        ref: "ACE-D4M1Z2",
      });
      await seedMovement({
        regime: "ACI",
        driver: dale,
        truck: t103,
        trailers: [],
        portCode: WIN,
        etaDays: -1,
        shipments: [fab("ACI")],
        seals: [],
        path: ["cancelled"],
      });

      // Unassigned shipments: keyed in from a broker's email, waiting for a trip.
      await seedShipment({
        regime: "ACE",
        carrierCode: "PFTR",
        type: "regular_bill",
        controlReference: "PAPS90001",
        shipper: maple,
        consignee: glf,
        movementId: null,
        commodities: [steelLine],
      });
      await seedShipment({
        regime: "ACE",
        carrierCode: "PFTR",
        type: "section_321",
        controlReference: "PAPS90002",
        shipper: erie,
        consignee: glf,
        movementId: null,
        commodities: [{ ...produceLine, kg: 900, qty: 4, value: 780 }],
      });
      await seedShipment({
        regime: "ACI",
        carrierCode: "7ELU",
        type: "regular",
        controlReference: "PARS90003",
        shipper: glf,
        consignee: maple,
        movementId: null,
        isPars: true,
        commodities: [fabLine],
      });

      await sql`
        insert into public.organization_counters (organization_id, key, value)
        values (${orgId}, ${"movement:" + new Date().getUTCFullYear()}, ${seq})
        on conflict (organization_id, key) do update set value = greatest(organization_counters.value, excluded.value)`;
    }

    console.log(
      `seeded org ${DEMO_ORG.name} (${orgId}) with ${DEMO_USERS.length} users + registries + movements`,
    );
    console.log(`seeded org ${OTHER_ORG.name} (${otherOrgId}) with 1 user`);

    // 4b. document intelligence: one reviewed-ready extraction and one failure,
    //     so /documents demos both halves without an upload + model round-trip.
    //     Idempotent on original_filename (storage_path is unique anyway).
    const [uploader] = await sql<{ id: string }[]>`
      select id from auth.users where email = 'dispatch@pathfinder.demo'`;
    const [draft] = await sql<{ id: string }[]>`
      select id from public.movements
      where organization_id = ${orgId} and status = 'draft'
      order by movement_number limit 1`;
    const bolExtraction = JSON.parse(
      readFileSync(
        resolve(here, "../../ai/src/eval/fixtures/bol-steel-coils.expected.json"),
        "utf8",
      ),
    ) as Json;

    const seedDocument = async (doc: {
      filename: string;
      documentType: "bol" | "invoice";
      status: "extracted" | "failed";
      movementId: string | null;
      extractedJson?: Json;
      confidence?: number;
      error?: string;
    }) => {
      const [existing] = await sql<{ id: string }[]>`
        select id from public.source_documents
        where organization_id = ${orgId} and original_filename = ${doc.filename} limit 1`;
      if (existing) return existing.id;
      const [row] = await sql<{ id: string }[]>`
        insert into public.source_documents (
          organization_id, movement_id, document_type, detected_type, storage_path,
          original_filename, mime_type, size_bytes, upload_status, extracted_json,
          extraction_model, extraction_confidence, extraction_error,
          extraction_started_at, extraction_completed_at, uploaded_by)
        values (
          ${orgId}, ${doc.movementId}, ${doc.documentType},
          ${doc.status === "extracted" ? doc.documentType : null},
          ${`${orgId}/seed-${doc.filename}`}, ${doc.filename}, 'application/pdf', 248_000,
          ${doc.status}, ${doc.extractedJson ? sql.json(doc.extractedJson) : null},
          'mock', ${doc.confidence ?? null}, ${doc.error ?? null},
          now() - interval '4 minutes', now() - interval '3 minutes', ${uploader?.id ?? null})
        returning id`;
      return row!.id;
    };

    await seedDocument({
      filename: "bol-steel-coils.pdf",
      documentType: "bol",
      status: "extracted",
      movementId: draft?.id ?? null,
      extractedJson: bolExtraction,
      confidence: 0.82,
    });
    await seedDocument({
      filename: "invoice-erie-produce.pdf",
      documentType: "invoice",
      status: "failed",
      movementId: null,
      error: "extraction produced no usable lines | commodity description missing on every row",
    });

    // 4c. compliance alerts across the three statuses a reviewer works through.
    //     The truck alert carries the dedupe key the expiry rules generate, so a
    //     rescan reconciles it in place instead of raising a duplicate; the two
    //     movement alerts use a `demo:` key no rule engine produces.
    const [t102] = await sql<{ id: string }[]>`
      select id from public.trucks where organization_id = ${orgId} and unit_number = 'T-102' limit 1`;
    const [heldMovement] = await sql<{ id: string; movement_number: string }[]>`
      select id, movement_number from public.movements
      where organization_id = ${orgId} and status = 'held' limit 1`;
    const [complianceUser] = await sql<{ id: string }[]>`
      select id from auth.users where email = 'compliance@pathfinder.demo'`;

    const seedAlert = async (alert: {
      dedupeKey: string;
      alertType: "document_expiry" | "risk_flag" | "hs_code_mismatch";
      severity: "info" | "warning" | "critical";
      status: "open" | "acknowledged" | "resolved";
      source: "rules" | "ai" | "user";
      title: string;
      description: string;
      truckId?: string | null;
      movementId?: string | null;
      dueAt?: string | null;
      metadata?: Json;
    }) => {
      const [existing] = await sql<{ id: string }[]>`
        select id from public.compliance_alerts
        where organization_id = ${orgId} and dedupe_key = ${alert.dedupeKey} limit 1`;
      if (existing) return;
      await sql`
        insert into public.compliance_alerts (
          organization_id, movement_id, truck_id, alert_type, severity, title, description,
          status, dedupe_key, source, due_at, acknowledged_by, acknowledged_at,
          resolved_by, resolved_at, metadata)
        values (
          ${orgId}, ${alert.movementId ?? null}, ${alert.truckId ?? null}, ${alert.alertType},
          ${alert.severity}, ${alert.title}, ${alert.description}, ${alert.status},
          ${alert.dedupeKey}, ${alert.source}, ${alert.dueAt ?? null},
          ${alert.status === "acknowledged" ? (complianceUser?.id ?? null) : null},
          ${alert.status === "acknowledged" ? sql`now() - interval '2 hours'` : null},
          ${alert.status === "resolved" ? (complianceUser?.id ?? null) : null},
          ${alert.status === "resolved" ? sql`now() - interval '1 day'` : null},
          ${sql.json(alert.metadata ?? {})})`;
    };

    if (t102) {
      await seedAlert({
        dedupeKey: `truck:${t102.id}:registration_expiry`,
        alertType: "document_expiry",
        severity: "critical",
        status: "open",
        source: "rules",
        title: "Registration expired — Truck T-102",
        description:
          "Registration for Truck T-102 has expired. Customs will reject a manifest using an unverifiable document.",
        truckId: t102.id,
        dueAt: day(-3),
        metadata: { field: "registration_expiry", entityType: "truck" },
      });
    }
    if (heldMovement) {
      await seedAlert({
        dedupeKey: `demo:risk_flag:${heldMovement.id}`,
        alertType: "risk_flag",
        severity: "warning",
        status: "acknowledged",
        source: "ai",
        title: `Elevated hold risk on ${heldMovement.movement_number}`,
        description:
          "Perishable produce at a crossing with an above-average inspection rate for this commodity. Confirm the PGA data before the truck leaves.",
        movementId: heldMovement.id,
        metadata: { holdProbability: 0.41, factors: ["commodity", "crossing_history"] },
      });
      await seedAlert({
        dedupeKey: `demo:hs_code_mismatch:${heldMovement.id}`,
        alertType: "hs_code_mismatch",
        severity: "info",
        status: "resolved",
        source: "rules",
        title: `HS code corrected on ${heldMovement.movement_number}`,
        description:
          "The declared HS code did not match the commodity description on line 1. The broker confirmed the corrected classification.",
        movementId: heldMovement.id,
        metadata: { lineNumber: 1, declared: "0810.10", corrected: "0810.90" },
      });
    }
    console.log("seeded 2 source documents + 3 compliance alerts for the demo org");

    // 5. copilot regulation corpus — global, not tenant-scoped. Idempotent:
    //    ingestRegulations upserts by (source, title) and replaces embeddings.
    const ingestResult = await ingestRegulations({
      async upsertDocument(doc) {
        const [existing] = await sql<{ id: string }[]>`
          select id from public.regulation_documents where source = ${doc.source} and title = ${doc.title} limit 1`;
        if (existing) {
          await sql`
            update public.regulation_documents
            set jurisdiction = ${doc.jurisdiction}, url = ${doc.url}, content = ${doc.content}
            where id = ${existing.id}`;
          return existing.id;
        }
        const [row] = await sql<{ id: string }[]>`
          insert into public.regulation_documents (source, title, jurisdiction, url, content)
          values (${doc.source}, ${doc.title}, ${doc.jurisdiction}, ${doc.url}, ${doc.content})
          returning id`;
        return row!.id;
      },
      async replaceEmbeddings(documentId, chunks) {
        await sql`delete from public.regulation_embeddings where regulation_document_id = ${documentId}`;
        for (const c of chunks) {
          const vectorLiteral = `[${c.embedding.join(",")}]`;
          await sql`
            insert into public.regulation_embeddings (regulation_document_id, chunk_index, content, embedding)
            values (${documentId}, ${c.chunkIndex}, ${c.content}, ${vectorLiteral}::vector)`;
        }
      },
    });
    console.log(
      `ingested ${ingestResult.documents} regulation(s) / ${ingestResult.chunks} chunk(s) via ${ingestResult.embedder}`,
    );

    return { orgId, otherOrgId };
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  seed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
