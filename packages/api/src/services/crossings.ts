/**
 * Crossing report (Task 12): one row per movement whose crossing date
 * (scheduled, else created) falls in the range, with the crew, equipment and
 * shipment facts folded in as text so any column set can go straight to a
 * table, a CSV or a PDF.
 */
import { sql, type RlsTransaction } from "@corridor/db";
import { CROSSING_REPORT_COLUMNS, type CrossingColumn, type CrossingReportInput } from "@corridor/domain";
import { pickColumns } from "./reporting-export";

interface RawRow {
  id: string;
  movement_number: string;
  trip_number: string | null;
  regime: string;
  carrier_code: string | null;
  status: string;
  port_code: string | null;
  port_name: string | null;
  scheduled_crossing_at: Date | string | null;
  submitted_at: Date | string | null;
  accepted_at: Date | string | null;
  released_at: Date | string | null;
  arrived_at: Date | string | null;
  pic_driver: string | null;
  crew: string | null;
  truck_unit: string | null;
  truck_plate: string | null;
  trailer_units: string | null;
  seal_numbers: string | null;
  shipment_count: number;
  control_numbers: string | null;
  entry_numbers: string | null;
  shippers: string | null;
  consignees: string | null;
  commodity_count: number;
  total_weight_kg: number;
  declared_value: number;
  total: number;
}

export type CrossingRow = { id: string } & Record<CrossingColumn, string | number | null>;

/** "2026-09-08 14:05" in the organization's timezone; the report is read by dispatch, not by a machine. */
export function stampInZone(value: Date | string | null, timeZone: string): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

export async function crossingReport(
  tx: RlsTransaction,
  orgId: string,
  input: CrossingReportInput,
  timeZone = "America/Toronto",
) {
  const rows = (await tx.execute(sql`
    with m as (
      select m.*, coalesce(m.scheduled_crossing_at, m.created_at) as crossing_at
      from public.movements m
      where m.organization_id = ${orgId}
        and coalesce(m.scheduled_crossing_at, m.created_at) >= ${input.from}::date
        and coalesce(m.scheduled_crossing_at, m.created_at) < (${input.to}::date + 1)
        ${input.regime ? sql`and m.regime = ${input.regime}` : sql``}
        ${input.portId ? sql`and m.port_id = ${input.portId}` : sql``}
        ${input.truckId ? sql`and m.truck_id = ${input.truckId}` : sql``}
        ${
          input.driverId
            ? sql`and exists (select 1 from public.movement_crew c where c.movement_id = m.id and c.driver_id = ${input.driverId})`
            : sql``
        }
        ${
          input.trailerId
            ? sql`and exists (select 1 from public.movement_trailers t where t.movement_id = m.id and t.trailer_id = ${input.trailerId})`
            : sql``
        }
    )
    select
      m.id, m.movement_number, m.trip_number, m.regime, m.carrier_code, m.status,
      p.code as port_code, p.name as port_name,
      m.scheduled_crossing_at, m.submitted_at, m.accepted_at, m.released_at, m.arrived_at,
      (select d.first_name || ' ' || d.last_name from public.movement_crew c
         join public.drivers d on d.id = c.driver_id
         where c.movement_id = m.id and c.role = 'person_in_charge' limit 1) as pic_driver,
      (select string_agg(d.first_name || ' ' || d.last_name, ', ' order by c.role, d.last_name)
         from public.movement_crew c join public.drivers d on d.id = c.driver_id
         where c.movement_id = m.id and c.role <> 'person_in_charge') as crew,
      t.unit_number as truck_unit, t.plate_number as truck_plate,
      (select string_agg(tr.unit_number, ', ' order by mt.position)
         from public.movement_trailers mt join public.trailers tr on tr.id = mt.trailer_id
         where mt.movement_id = m.id) as trailer_units,
      (select string_agg(s.seal_number, ', ' order by s.seal_number)
         from public.seals s where s.movement_id = m.id) as seal_numbers,
      (select count(*)::int from public.shipments s where s.movement_id = m.id) as shipment_count,
      (select string_agg(s.control_number, ', ' order by s.control_number)
         from public.shipments s where s.movement_id = m.id) as control_numbers,
      (select string_agg(s.entry_number, ', ' order by s.entry_number)
         from public.shipments s where s.movement_id = m.id and s.entry_number is not null) as entry_numbers,
      (select string_agg(distinct pa.name, ', ') from public.shipments s
         join public.partners pa on pa.id = s.shipper_id where s.movement_id = m.id) as shippers,
      (select string_agg(distinct pa.name, ', ') from public.shipments s
         join public.partners pa on pa.id = s.consignee_id where s.movement_id = m.id) as consignees,
      (select count(*)::int from public.commodities c
         join public.shipments s on s.id = c.shipment_id where s.movement_id = m.id) as commodity_count,
      (select coalesce(sum(c.weight_kg), 0)::float8 from public.commodities c
         join public.shipments s on s.id = c.shipment_id where s.movement_id = m.id) as total_weight_kg,
      (select coalesce(sum(c.value_amount), 0)::float8 from public.commodities c
         join public.shipments s on s.id = c.shipment_id where s.movement_id = m.id) as declared_value,
      count(*) over ()::int as total
    from m
    left join public.ports p on p.id = m.port_id
    left join public.trucks t on t.id = m.truck_id
    order by m.crossing_at desc, m.movement_number
    limit ${input.limit} offset ${input.offset}
  `)) as unknown as RawRow[];

  const stamp = (v: Date | string | null) => stampInZone(v, timeZone);
  const mapped: CrossingRow[] = rows.map((r) => ({
    id: r.id,
    movementNumber: r.movement_number,
    tripNumber: r.trip_number,
    regime: r.regime,
    carrierCode: r.carrier_code,
    status: r.status,
    portCode: r.port_code,
    portName: r.port_name,
    scheduledCrossingAt: stamp(r.scheduled_crossing_at),
    submittedAt: stamp(r.submitted_at),
    acceptedAt: stamp(r.accepted_at),
    releasedAt: stamp(r.released_at),
    arrivedAt: stamp(r.arrived_at),
    picDriver: r.pic_driver,
    crew: r.crew,
    truckUnit: r.truck_unit,
    truckPlate: r.truck_plate,
    trailerUnits: r.trailer_units,
    sealNumbers: r.seal_numbers,
    shipmentCount: Number(r.shipment_count ?? 0),
    controlNumbers: r.control_numbers,
    entryNumbers: r.entry_numbers,
    shippers: r.shippers,
    consignees: r.consignees,
    commodityCount: Number(r.commodity_count ?? 0),
    totalWeightKg: Number(r.total_weight_kg ?? 0),
    declaredValue: Number(r.declared_value ?? 0),
  }));
  return {
    columns: pickColumns(CROSSING_REPORT_COLUMNS, input.columns),
    rows: mapped,
    total: Number(rows[0]?.total ?? 0),
  };
}

export interface DashboardData {
  thisMonth: { ACE: number; ACI: number };
  series: Array<{ month: string; ACE: number; ACI: number }>;
  recentShipments: Array<{
    id: string;
    controlNumber: string;
    status: string;
    entryNumber: string | null;
    movementNumber: string | null;
    updatedAt: string;
  }>;
}

/** Movements created per month for the trailing year, plus the ten shipments touched most recently. */
export async function dashboardData(tx: RlsTransaction, orgId: string): Promise<DashboardData> {
  const series = (await tx.execute(sql`
    with months as (
      select to_char(date_trunc('month', now()) - (interval '1 month' * g), 'YYYY-MM') as month
      from generate_series(11, 0, -1) as g
    )
    select months.month,
      coalesce(sum(case when m.regime = 'ACE' then 1 else 0 end), 0)::int as ace,
      coalesce(sum(case when m.regime = 'ACI' then 1 else 0 end), 0)::int as aci
    from months
    left join public.movements m
      on m.organization_id = ${orgId}
     and to_char(date_trunc('month', m.created_at), 'YYYY-MM') = months.month
    group by months.month
    order by months.month
  `)) as unknown as Array<{ month: string; ace: number; aci: number }>;
  const recent = (await tx.execute(sql`
    select s.id, s.control_number, s.status, s.entry_number, m.movement_number, s.updated_at
    from public.shipments s
    left join public.movements m on m.id = s.movement_id
    where s.organization_id = ${orgId}
    order by s.updated_at desc
    limit 10
  `)) as unknown as Array<{
    id: string;
    control_number: string;
    status: string;
    entry_number: string | null;
    movement_number: string | null;
    updated_at: Date | string;
  }>;
  const last = series[series.length - 1];
  return {
    thisMonth: { ACE: Number(last?.ace ?? 0), ACI: Number(last?.aci ?? 0) },
    series: series.map((r) => ({ month: r.month, ACE: Number(r.ace), ACI: Number(r.aci) })),
    recentShipments: recent.map((r) => ({
      id: r.id,
      controlNumber: r.control_number,
      status: r.status,
      entryNumber: r.entry_number,
      movementNumber: r.movement_number,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
  };
}
