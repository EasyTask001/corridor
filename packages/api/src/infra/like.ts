/** Escape the LIKE metacharacters so user text matches literally (Postgres default escape is backslash). */
export const escapeLike = (s: string): string => s.replace(/[%_\\]/g, "\\$&");
/** `%term%` with the term escaped — the shape every search endpoint uses. */
export const containsPattern = (s: string): string => `%${escapeLike(s.trim())}%`;
