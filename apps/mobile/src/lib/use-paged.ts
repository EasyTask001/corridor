/**
 * The mobile app has no React Query cache (see `use-async.ts`), so paging
 * through `notifications.list`'s keyset cursor needs its own tiny, pure
 * accumulator instead of pulling in a pagination library.
 */
export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

/**
 * Appends `next`'s rows onto `prev`, de-duplicating by id (a retried fetch
 * or a row that shifted pages between requests must not double up) and
 * carrying `next`'s cursor forward so the caller always knows where to
 * resume.
 */
export function appendPage<T extends { id: string }>(
  prev: Page<T> | undefined,
  next: Page<T>,
): Page<T> {
  const seen = new Set(prev?.rows.map((r) => r.id));
  return {
    rows: [...(prev?.rows ?? []), ...next.rows.filter((r) => !seen.has(r.id))],
    nextCursor: next.nextCursor,
  };
}
