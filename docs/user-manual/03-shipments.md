# Shipments

A shipment is one customs filing: a PAPS or PARS number, the shipper and consignee, the port, and its commodity lines. It can exist before it is put on a truck and outlives the movement it crossed on.

## Creating shipments

- From a movement's **Shipments** step.
- From **Shipments → Import CSV** for a whole file at once (see Importing).

The control number is the carrier code plus your reference; Corridor refuses a duplicate.

## Partners on a shipment

For an ACE filing the shipper is normally in Canada and the consignee in the US; ACI is the reverse. The pickers show that side first. Tick **Show partners in any country** when a load does not follow the rule.

## Commodity lines

Each line carries description, HS code, quantity, weight, origin and value. Up to three hazmat entries (UN code, description, emergency contact) go on a line. Lines can be added until the movement is transmitted.

## Status

Statuses follow the movement's customs outcome: sent, accepted, entry on file, held, released, arrived. The entry number stamps itself when customs sends it.
