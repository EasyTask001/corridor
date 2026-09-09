-- =============================================================================
-- Corridor — 0031 tenant-safe referential integrity
--
-- Every relationship between two organization-owned tables must constrain both
-- the referenced ID and organization ID. RLS is still required, but it is not
-- the mechanism that proves a child and parent belong to the same tenant.
-- =============================================================================

-- Stop before changing constraints if any existing row would violate the new
-- invariant. This deliberately does not guess which organization owns bad data.
do $$
declare
  r record;
  v_mismatches bigint;
begin
  for r in
    select * from (values
      ('organization_members', 'role_id', 'roles'),
      ('compliance_alerts', 'driver_id', 'drivers'),
      ('compliance_alerts', 'movement_id', 'movements'),
      ('compliance_alerts', 'trailer_id', 'trailers'),
      ('compliance_alerts', 'truck_id', 'trucks'),
      ('movements', 'truck_id', 'trucks'),
      ('movement_events', 'movement_id', 'movements'),
      ('movement_events', 'shipment_id', 'shipments'),
      ('movement_amendments', 'movement_id', 'movements'),
      ('movement_amendments', 'shipment_id', 'shipments'),
      ('commodities', 'import_batch_id', 'import_batches'),
      ('commodities', 'shipment_id', 'shipments'),
      ('commodities', 'source_document_id', 'source_documents'),
      ('seals', 'movement_id', 'movements'),
      ('seals', 'movement_trailer_id', 'movement_trailers'),
      ('integration_events', 'movement_id', 'movements'),
      ('source_documents', 'applied_movement_id', 'movements'),
      ('source_documents', 'movement_id', 'movements'),
      ('movement_suggestions', 'movement_id', 'movements'),
      ('movement_suggestions', 'source_movement_id', 'movements'),
      ('shipments', 'consignee_id', 'partners'),
      ('shipments', 'import_batch_id', 'import_batches'),
      ('shipments', 'movement_id', 'movements'),
      ('shipments', 'shipper_id', 'partners'),
      ('shipments', 'source_document_id', 'source_documents'),
      ('commodity_hazmat', 'commodity_id', 'commodities'),
      ('movement_crew', 'movement_id', 'movements'),
      ('movement_trailers', 'movement_id', 'movements'),
      ('customs_submissions', 'movement_id', 'movements'),
      ('generated_documents', 'movement_id', 'movements'),
      ('in_bond_records', 'external_shipment_id', 'external_shipments'),
      ('in_bond_records', 'shipment_id', 'shipments'),
      ('in_bond_events', 'in_bond_record_id', 'in_bond_records'),
      ('pars_rns_events', 'shipment_id', 'shipments')
    ) as x(child_table, child_id, parent_table)
  loop
    execute format(
      'select count(*) from public.%I c join public.%I p on p.id = c.%I
       where c.%I is not null and c.organization_id is not null
         and p.organization_id is distinct from c.organization_id',
      r.child_table, r.parent_table, r.child_id, r.child_id
    ) into v_mismatches;
    if v_mismatches > 0 then
      raise exception '0031 tenant FK preflight failed: %.% has % rows whose organization_id differs from %.organization_id',
        r.child_table, r.child_id, v_mismatches, r.parent_table
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- A foreign key may reference a non-partial unique index. These keys make the
-- tenant pair an enforceable parent key without changing globally unique IDs.
create unique index if not exists roles_id_organization_unique
  on public.roles (id, organization_id);
create unique index if not exists partners_id_organization_unique
  on public.partners (id, organization_id);
create unique index if not exists movements_id_organization_unique
  on public.movements (id, organization_id);
create unique index if not exists import_batches_id_organization_unique
  on public.import_batches (id, organization_id);
create unique index if not exists shipments_id_organization_unique
  on public.shipments (id, organization_id);
create unique index if not exists source_documents_id_organization_unique
  on public.source_documents (id, organization_id);
create unique index if not exists commodities_id_organization_unique
  on public.commodities (id, organization_id);
create unique index if not exists commodity_hazmat_id_organization_unique
  on public.commodity_hazmat (id, organization_id);
create unique index if not exists movement_events_id_organization_unique
  on public.movement_events (id, organization_id);
create unique index if not exists movement_amendments_id_organization_unique
  on public.movement_amendments (id, organization_id);
create unique index if not exists seals_id_organization_unique
  on public.seals (id, organization_id);
create unique index if not exists integration_events_id_organization_unique
  on public.integration_events (id, organization_id);
create unique index if not exists movement_suggestions_id_organization_unique
  on public.movement_suggestions (id, organization_id);
create unique index if not exists customs_submissions_id_organization_unique
  on public.customs_submissions (id, organization_id);
create unique index if not exists generated_documents_id_organization_unique
  on public.generated_documents (id, organization_id);
create unique index if not exists in_bond_records_id_organization_unique
  on public.in_bond_records (id, organization_id);
create unique index if not exists external_shipments_id_organization_unique
  on public.external_shipments (id, organization_id);
create unique index if not exists in_bond_events_id_organization_unique
  on public.in_bond_events (id, organization_id);
create unique index if not exists pars_rns_events_id_organization_unique
  on public.pars_rns_events (id, organization_id);
create unique index if not exists movement_trailers_id_organization_unique
  on public.movement_trailers (id, organization_id);

alter table public.organization_members
  drop constraint organization_members_role_id_fkey,
  add constraint organization_members_role_org_fkey
  foreign key (role_id, organization_id)
  references public.roles (id, organization_id)
  on delete restrict;

alter table public.compliance_alerts
  drop constraint compliance_alerts_driver_id_fkey,
  add constraint compliance_alerts_driver_org_fkey
  foreign key (driver_id, organization_id)
  references public.drivers (id, organization_id)
  on delete cascade,
  drop constraint compliance_alerts_movement_id_fkey,
  add constraint compliance_alerts_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade,
  drop constraint compliance_alerts_trailer_id_fkey,
  add constraint compliance_alerts_trailer_org_fkey
  foreign key (trailer_id, organization_id)
  references public.trailers (id, organization_id)
  on delete cascade,
  drop constraint compliance_alerts_truck_id_fkey,
  add constraint compliance_alerts_truck_org_fkey
  foreign key (truck_id, organization_id)
  references public.trucks (id, organization_id)
  on delete cascade;

alter table public.movements
  drop constraint movements_truck_id_fkey,
  add constraint movements_truck_org_fkey
  foreign key (truck_id, organization_id)
  references public.trucks (id, organization_id)
  on delete restrict;

alter table public.movement_events
  drop constraint movement_events_movement_id_fkey,
  add constraint movement_events_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade,
  drop constraint movement_events_shipment_id_fkey,
  add constraint movement_events_shipment_org_fkey
  foreign key (shipment_id, organization_id)
  references public.shipments (id, organization_id)
  on delete set null (shipment_id);

alter table public.movement_amendments
  drop constraint movement_amendments_movement_id_fkey,
  add constraint movement_amendments_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade,
  drop constraint movement_amendments_shipment_id_fkey,
  add constraint movement_amendments_shipment_org_fkey
  foreign key (shipment_id, organization_id)
  references public.shipments (id, organization_id)
  on delete set null (shipment_id);

alter table public.commodities
  drop constraint commodities_import_batch_id_fkey,
  add constraint commodities_import_batch_org_fkey
  foreign key (import_batch_id, organization_id)
  references public.import_batches (id, organization_id)
  on delete set null (import_batch_id),
  drop constraint commodities_shipment_id_fkey,
  add constraint commodities_shipment_org_fkey
  foreign key (shipment_id, organization_id)
  references public.shipments (id, organization_id)
  on delete cascade,
  drop constraint commodities_source_document_id_fkey,
  add constraint commodities_source_document_org_fkey
  foreign key (source_document_id, organization_id)
  references public.source_documents (id, organization_id)
  on delete set null (source_document_id);

alter table public.seals
  drop constraint seals_movement_id_fkey,
  add constraint seals_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade,
  drop constraint seals_movement_trailer_id_fkey,
  add constraint seals_movement_trailer_org_fkey
  foreign key (movement_trailer_id, organization_id)
  references public.movement_trailers (id, organization_id)
  on delete cascade;

alter table public.integration_events
  drop constraint integration_events_movement_id_fkey,
  add constraint integration_events_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete set null (movement_id);

alter table public.source_documents
  drop constraint source_documents_applied_movement_id_fkey,
  add constraint source_documents_applied_movement_org_fkey
  foreign key (applied_movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete set null (applied_movement_id),
  drop constraint source_documents_movement_id_fkey,
  add constraint source_documents_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete set null (movement_id);

alter table public.movement_suggestions
  drop constraint movement_suggestions_movement_id_fkey,
  add constraint movement_suggestions_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade,
  drop constraint movement_suggestions_source_movement_id_fkey,
  add constraint movement_suggestions_source_movement_org_fkey
  foreign key (source_movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade;

alter table public.shipments
  drop constraint shipments_consignee_id_fkey,
  add constraint shipments_consignee_org_fkey
  foreign key (consignee_id, organization_id)
  references public.partners (id, organization_id)
  on delete restrict,
  drop constraint shipments_import_batch_id_fkey,
  add constraint shipments_import_batch_org_fkey
  foreign key (import_batch_id, organization_id)
  references public.import_batches (id, organization_id)
  on delete set null (import_batch_id),
  drop constraint shipments_movement_id_fkey,
  add constraint shipments_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete set null (movement_id),
  drop constraint shipments_shipper_id_fkey,
  add constraint shipments_shipper_org_fkey
  foreign key (shipper_id, organization_id)
  references public.partners (id, organization_id)
  on delete restrict,
  drop constraint shipments_source_document_id_fkey,
  add constraint shipments_source_document_org_fkey
  foreign key (source_document_id, organization_id)
  references public.source_documents (id, organization_id)
  on delete set null (source_document_id);

alter table public.commodity_hazmat
  drop constraint commodity_hazmat_commodity_id_fkey,
  add constraint commodity_hazmat_commodity_org_fkey
  foreign key (commodity_id, organization_id)
  references public.commodities (id, organization_id)
  on delete cascade;

alter table public.movement_crew
  drop constraint movement_crew_movement_id_fkey,
  add constraint movement_crew_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade;

alter table public.movement_trailers
  drop constraint movement_trailers_movement_id_fkey,
  add constraint movement_trailers_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade;

alter table public.customs_submissions
  drop constraint customs_submissions_movement_id_fkey,
  add constraint customs_submissions_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade;

alter table public.generated_documents
  drop constraint generated_documents_movement_id_fkey,
  add constraint generated_documents_movement_org_fkey
  foreign key (movement_id, organization_id)
  references public.movements (id, organization_id)
  on delete cascade;

alter table public.in_bond_records
  drop constraint in_bond_records_external_shipment_id_fkey,
  add constraint in_bond_records_external_shipment_org_fkey
  foreign key (external_shipment_id, organization_id)
  references public.external_shipments (id, organization_id)
  on delete cascade,
  drop constraint in_bond_records_shipment_id_fkey,
  add constraint in_bond_records_shipment_org_fkey
  foreign key (shipment_id, organization_id)
  references public.shipments (id, organization_id)
  on delete cascade;

alter table public.in_bond_events
  drop constraint in_bond_events_in_bond_record_id_fkey,
  add constraint in_bond_events_in_bond_record_org_fkey
  foreign key (in_bond_record_id, organization_id)
  references public.in_bond_records (id, organization_id)
  on delete cascade;

alter table public.pars_rns_events
  drop constraint pars_rns_events_shipment_id_fkey,
  add constraint pars_rns_events_shipment_org_fkey
  foreign key (shipment_id, organization_id)
  references public.shipments (id, organization_id)
  on delete set null (shipment_id);

-- Child-side indexes support the composite FK checks and the same-tenant joins.
create index if not exists organization_members_org_role_idx on public.organization_members (organization_id, role_id);
create index if not exists compliance_alerts_org_driver_idx on public.compliance_alerts (organization_id, driver_id);
create index if not exists compliance_alerts_org_movement_idx on public.compliance_alerts (organization_id, movement_id);
create index if not exists compliance_alerts_org_trailer_idx on public.compliance_alerts (organization_id, trailer_id);
create index if not exists compliance_alerts_org_truck_idx on public.compliance_alerts (organization_id, truck_id);
create index if not exists movements_org_truck_idx on public.movements (organization_id, truck_id) where truck_id is not null;
create index if not exists movement_events_org_movement_idx on public.movement_events (organization_id, movement_id);
create index if not exists movement_events_org_shipment_idx on public.movement_events (organization_id, shipment_id) where shipment_id is not null;
create index if not exists movement_amendments_org_movement_idx on public.movement_amendments (organization_id, movement_id);
create index if not exists movement_amendments_org_shipment_idx on public.movement_amendments (organization_id, shipment_id) where shipment_id is not null;
create index if not exists commodities_org_import_batch_idx on public.commodities (organization_id, import_batch_id) where import_batch_id is not null;
create index if not exists commodities_org_shipment_idx on public.commodities (organization_id, shipment_id);
create index if not exists commodities_org_source_document_idx on public.commodities (organization_id, source_document_id) where source_document_id is not null;
create index if not exists seals_org_movement_idx on public.seals (organization_id, movement_id);
create index if not exists seals_org_movement_trailer_idx on public.seals (organization_id, movement_trailer_id);
create index if not exists integration_events_org_movement_idx on public.integration_events (organization_id, movement_id) where movement_id is not null;
create index if not exists source_documents_org_applied_movement_idx on public.source_documents (organization_id, applied_movement_id) where applied_movement_id is not null;
create index if not exists source_documents_org_movement_idx on public.source_documents (organization_id, movement_id) where movement_id is not null;
create index if not exists movement_suggestions_org_movement_idx on public.movement_suggestions (organization_id, movement_id);
create index if not exists movement_suggestions_org_source_movement_idx on public.movement_suggestions (organization_id, source_movement_id);
create index if not exists shipments_org_consignee_idx on public.shipments (organization_id, consignee_id) where consignee_id is not null;
create index if not exists shipments_org_import_batch_idx on public.shipments (organization_id, import_batch_id) where import_batch_id is not null;
create index if not exists shipments_org_movement_idx on public.shipments (organization_id, movement_id) where movement_id is not null;
create index if not exists shipments_org_shipper_idx on public.shipments (organization_id, shipper_id) where shipper_id is not null;
create index if not exists shipments_org_source_document_idx on public.shipments (organization_id, source_document_id) where source_document_id is not null;
create index if not exists commodity_hazmat_org_commodity_idx on public.commodity_hazmat (organization_id, commodity_id);
create index if not exists movement_crew_org_movement_idx on public.movement_crew (organization_id, movement_id);
create index if not exists movement_trailers_org_movement_idx on public.movement_trailers (organization_id, movement_id);
create index if not exists customs_submissions_org_movement_idx on public.customs_submissions (organization_id, movement_id) where movement_id is not null;
create index if not exists generated_documents_org_movement_idx on public.generated_documents (organization_id, movement_id) where movement_id is not null;
create index if not exists in_bond_records_org_external_idx on public.in_bond_records (organization_id, external_shipment_id);
create index if not exists in_bond_records_org_shipment_idx on public.in_bond_records (organization_id, shipment_id);
create index if not exists in_bond_events_org_record_idx on public.in_bond_events (organization_id, in_bond_record_id);
create index if not exists pars_rns_events_org_shipment_idx on public.pars_rns_events (organization_id, shipment_id) where shipment_id is not null;
