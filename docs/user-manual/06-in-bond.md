# In-bond

An in-bond shipment (IT, TE or IE) moves under bond from the port of entry to an inland destination. Corridor tracks each one from arrival to export or closure.

## Our own shipments

A shipment with an in-bond entry type gets a record on the **In-bond** monitor as soon as it is created. From there you **send arrival**, **send export**, **cancel**, or **request status**; each call and answer is kept as an event.

## Goods another carrier filed

Under **External shipments** record a bond someone else opened that you are moving: the bond number, the filer, the ports and the dates. It appears on the same monitor.

## Permissions

Reading the monitor needs `inbond.read`; sending or recording needs `inbond.write`. Dispatchers have both by default.
