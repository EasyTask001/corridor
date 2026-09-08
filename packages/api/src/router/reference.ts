/** Global lookups: ports/offices for the trip step and filters, equipment types for the registry. */
import { and, asc, eq, ilike, or, schema } from "@corridor/db";
import { portsSearchInput } from "@corridor/domain";
import { orgProcedure, router } from "../trpc";

const { ports, equipmentTypes } = schema;

export const referenceRouter = router({
  ports: router({
    search: orgProcedure.input(portsSearchInput).query(({ ctx, input }) =>
      ctx.rls(async (tx) => {
        const conds = [eq(ports.active, true)];
        if (input.regime) conds.push(eq(ports.regime, input.regime));
        if (input.kind) conds.push(eq(ports.kind, input.kind));
        if (input.q) {
          const like = `%${input.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
          conds.push(or(ilike(ports.code, like), ilike(ports.name, like))!);
        }
        return tx
          .select()
          .from(ports)
          .where(and(...conds))
          .orderBy(ports.code)
          .limit(input.limit);
      }),
    ),
  }),
  /** CBP equipment description codes (migration 0021) for the trailer registry. */
  equipmentTypes: router({
    list: orgProcedure.query(({ ctx }) =>
      ctx.rls((tx) => tx.select().from(equipmentTypes).orderBy(asc(equipmentTypes.label))),
    ),
  }),
});
