import type { MOVEMENT_STATUSES, SHIPMENT_STATUSES } from "../schema/movements";

export interface MigrationExceptionDetails {
  category: string;
  sourceId: string;
  fieldLabel: string;
  displayedValue: unknown;
  reason: string;
  blocking: boolean;
}

export class MigrationException extends Error implements MigrationExceptionDetails {
  readonly category: string;
  readonly sourceId: string;
  readonly fieldLabel: string;
  readonly displayedValue: unknown;
  readonly reason: string;
  readonly blocking: boolean;

  constructor(details: MigrationExceptionDetails) {
    super(
      `${details.category}/${details.sourceId}: ${details.fieldLabel} ${details.reason}`,
    );
    this.name = "MigrationException";
    this.category = details.category;
    this.sourceId = details.sourceId;
    this.fieldLabel = details.fieldLabel;
    this.displayedValue = details.displayedValue;
    this.reason = details.reason;
    this.blocking = details.blocking;
  }
}

type MovementStatus = (typeof MOVEMENT_STATUSES)[number];
type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const normalized = (value: string): string =>
  value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

const movementStatuses: Record<string, MovementStatus> = {
  draft: "draft",
  new: "draft",
  sent: "sent",
  submitted: "sent",
  transmitted: "sent",
  accepted: "accepted",
  rejected: "rejected",
  released: "released",
  held: "held",
  "on hold": "held",
  arrived: "arrived",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const shipmentStatuses: Record<string, ShipmentStatus> = {
  ...movementStatuses,
  "entry on file": "entry_on_file",
  "entry filed": "entry_on_file",
};

const unknownStatus = (kind: "movement" | "shipment", value: string): never => {
  throw new MigrationException({
    category: kind,
    sourceId: "status-mapping",
    fieldLabel: "Status",
    displayedValue: value,
    reason: "has no verified Corridor status mapping",
    blocking: true,
  });
};

export const mapMovementStatus = (value: string): MovementStatus =>
  movementStatuses[normalized(value)] ?? unknownStatus("movement", value);

export const mapShipmentStatus = (value: string): ShipmentStatus =>
  shipmentStatuses[normalized(value)] ?? unknownStatus("shipment", value);
