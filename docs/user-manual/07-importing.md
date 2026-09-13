# Importing from a file

**Shipments → Import CSV** loads a whole file of shipments, or of commodity lines for shipments that already exist.

## Templates

Download the header row from the import page, or start from the samples in `docs/import-templates/`: `ace-shipments.csv`, `aci-cargo.csv`, `commodities.csv`. Headers are matched case-insensitively; spaces and dashes count as underscores. Files may be `.csv`, `.txt` or `.dat`; the delimiter is detected.

## Validate, then commit

1. Choose what the file holds and pick the file.
2. **Validate**: every line gets a verdict. Partners are matched by name, broker assignments must match a broker or dual-role party, ports by code, and carrier codes against the ones on file. Duplicate control numbers, in the file or already in Corridor, are errors.
3. **Commit** writes only the lines that passed, all at once.

## Undo

A committed batch shows **Delete rows** while its rows are still drafts. Rows already on a transmitted manifest stay and are listed.
