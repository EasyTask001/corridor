import { z } from "zod";

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
export const nonEmpty = z.string().trim().min(1);
export const email = z.string().trim().toLowerCase().email();

export const paginationInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});
export type PaginationInput = z.infer<typeof paginationInput>;

export const timestamps = z.object({
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
