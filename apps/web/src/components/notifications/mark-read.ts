/**
 * Optimistic "this row is now read" patch, shared by the bell and the
 * notifications page so both show the same thing before the server answers.
 * The server sets `read_at = now()`; the exact instant is reconciled by the
 * invalidation in `onSettled`, so a client clock is good enough here.
 */
export function markedRead<T extends { readAt: Date | null }>(row: T): T {
  return row.readAt ? row : { ...row, readAt: new Date() };
}
