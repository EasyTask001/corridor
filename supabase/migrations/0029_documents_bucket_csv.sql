-- 0029 — CSV exports (Task 12) live in the documents bucket next to the PDFs.
-- The bucket's allow-list was fixed in 0005; this adds text/csv so a crossing
-- report or registry export can be stored and signed like any generated file.
-- No table changes.

update storage.buckets
set allowed_mime_types = array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/tiff',
  'text/plain', 'application/json', 'text/csv'
]
where id = 'documents';
