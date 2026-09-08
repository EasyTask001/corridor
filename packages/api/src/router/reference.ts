/** Global lookups: ports/offices for the trip step and filters, equipment types for the registry. */
import { z } from "zod";
import { and, asc, eq, ilike, or, schema } from "@corridor/db";
import { portsSearchInput, uuid } from "@corridor/domain";
import { getBorderWait, searchTariff } from "@corridor/integrations";
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
  /** Resources page (Task 13): the wait at one port, by its id, from the (mock or cached) feed. */
  borderWait: orgProcedure.input(z.object({ portId: uuid })).query(({ ctx, input }) =>
    ctx.rls(async (tx) => {
      const [port] = await tx
        .select({ id: ports.id, code: ports.code, name: ports.name, regime: ports.regime })
        .from(ports)
        .where(eq(ports.id, input.portId))
        .limit(1);
      if (!port) return null;
      return { port, wait: getBorderWait(port.code) };
    }),
  ),
  /** HTS / tariff search for the Resources page and the commodity form. */
  tariffSearch: orgProcedure
    .input(z.object({ q: z.string().trim().max(60) }))
    .query(({ input }) => searchTariff(input.q)),
  /** CBP equipment description codes (migration 0021) for the trailer registry. */
  equipmentTypes: router({
    list: orgProcedure.query(({ ctx }) =>
      ctx.rls((tx) => tx.select().from(equipmentTypes).orderBy(asc(equipmentTypes.label))),
    ),
  }),
});
