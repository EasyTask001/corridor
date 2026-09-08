# Movements

A movement is one truck crossing: the trip, the crew, the tractor, the trailers in tow order, the seals, and the shipments on board. The builder walks those steps and checks each before the manifest can be transmitted.

## Building a movement

1. **Trip**: regime, carrier code, port of entry or CBSA office, scheduled crossing. Tick **Empty** for a bobtail or empty trailer; the ACI flags (LVS, postal, flying truck, in-transit, IIT) are here too.
2. **Crew**: the person in charge and any crew or passengers. Expired documents raise an alert here.
3. **Truck**, **Trailers**, **Seals**: the tractor, trailers in the order they are towed, and up to four seals per trailer.
4. **Shipments**: add filings or pull unassigned ones from the pool.
5. **Review**: the full pre-flight list. Errors block transmit; warnings do not.

## After transmit

The timeline shows every customs event as it arrives: preliminary check, entry on file, hold, release. **Amend** re-transmits with a reason code (ACI needs one). A rejected manifest becomes editable again.

## Printing and sending

**Print** renders the driver sheet or the manifest summary; **E-mail** sends a signed link. Opted-in drivers receive an SMS when the entry is on file.
