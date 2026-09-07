import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, schema, withServiceRole } from "@corridor/db";
import {
  BILLING_PLANS,
  billingMode,
  createCheckout,
  createPortal,
  type SubscriptionSnapshot,
} from "@corridor/integrations";
import { permissionProcedure, router } from "../trpc";
import { logIntegrationEvent } from "../services/customs";
import { writeAudit } from "../services/audit";
import { usageForPlan } from "../services/usage";

const { organizations, subscriptions } = schema;

const planKey = z.enum(["starter", "professional", "enterprise"]);

/** Upsert the subscription mirror + org plan (service role: webhooks have no user). */
export async function upsertSubscription(
  db: Parameters<typeof withServiceRole>[0],
  snap: SubscriptionSnapshot,
) {
  return withServiceRole(db, async (tx) => {
    if (snap.stripeCustomerId) {
      await tx
        .update(organizations)
        .set({ stripeCustomerId: snap.stripeCustomerId })
        .where(eq(organizations.id, snap.organizationId));
    }
    const [row] = await tx
      .insert(subscriptions)
      .values({
        organizationId: snap.organizationId,
        stripeSubscriptionId: snap.stripeSubscriptionId,
        plan: snap.plan,
        status: snap.status,
        seats: snap.seats,
        currentPeriodEnd: snap.currentPeriodEnd,
        cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
      })
      .onConflictDoUpdate({
        target: subscriptions.organizationId,
        set: {
          stripeSubscriptionId: snap.stripeSubscriptionId,
          plan: snap.plan,
          status: snap.status,
          seats: snap.seats,
          currentPeriodEnd: snap.currentPeriodEnd,
          cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
        },
      })
      .returning();
    return row!;
  });
}

export const billingRouter = router({
  plans: permissionProcedure("billing.read").query(() => ({
    mode: billingMode(),
    plans: BILLING_PLANS,
  })),

  status: permissionProcedure("billing.read").query(({ ctx }) =>
    ctx.rls(async (tx) => {
      const [org] = await tx
        .select({
          plan: organizations.subscriptionPlan,
          status: organizations.subscriptionStatus,
          stripeCustomerId: organizations.stripeCustomerId,
          billingEmail: organizations.billingEmail,
        })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId));
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, ctx.orgId));
      // usage_records is readable under `billing.read` (migration 0013) — the
      // same permission that gates this procedure — so every caller who can see
      // the plan can see the meter it is billed against.
      const usage = await usageForPlan(tx, ctx.orgId, org!.plan);
      return { ...org!, subscription: sub ?? null, mode: billingMode(), usage };
    }),
  ),

  checkout: permissionProcedure("billing.manage")
    .input(
      z.object({
        plan: planKey,
        returnPath: z.string().startsWith("/").default("/settings/billing"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
      const org = await ctx.rls(async (tx) => {
        const [o] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
        return o!;
      });
      const res = await createCheckout({
        organizationId: ctx.orgId,
        plan: input.plan,
        customerId: org.stripeCustomerId,
        customerEmail: org.billingEmail ?? ctx.session.user.email,
        successUrl: `${base}${input.returnPath}?checkout=success`,
        cancelUrl: `${base}${input.returnPath}?checkout=cancelled`,
      });
      await ctx.rls(async (tx) => {
        await logIntegrationEvent(tx, {
          orgId: ctx.orgId,
          provider: "stripe",
          direction: "outbound",
          operation: "checkout.create",
          request: { plan: input.plan, mode: res.mode },
          response: { url: res.url },
          success: true,
        });
        await writeAudit(tx, ctx.orgId, "billing.session_opened", "subscription", ctx.orgId, null, {
          session: "checkout",
          plan: input.plan,
          mode: res.mode,
        });
      });
      return res;
    }),

  portal: permissionProcedure("billing.manage").mutation(async ({ ctx }) => {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const org = await ctx.rls(async (tx) => {
      const [o] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
      return o!;
    });
    if (billingMode() === "stripe" && !org.stripeCustomerId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "No Stripe customer yet — start a subscription first",
      });
    }
    const res = await createPortal(org.stripeCustomerId ?? "mock", `${base}/settings/billing`);
    await ctx.rls((tx) =>
      writeAudit(tx, ctx.orgId, "billing.session_opened", "subscription", ctx.orgId, null, {
        session: "portal",
        mode: res.mode,
      }),
    );
    return res;
  }),

  /** Mock-mode only: complete a "checkout" without Stripe. */
  mockActivate: permissionProcedure("billing.manage")
    .input(z.object({ plan: planKey }))
    .mutation(async ({ ctx, input }) => {
      if (billingMode() !== "mock") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Mock activation is disabled when Stripe is configured",
        });
      }
      const plan = BILLING_PLANS.find((p) => p.plan === input.plan)!;
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      const row = await upsertSubscription(ctx.db, {
        organizationId: ctx.orgId,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        plan: input.plan,
        status: "active",
        seats: plan.seats,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
      await ctx.rls(async (tx) => {
        await logIntegrationEvent(tx, {
          orgId: ctx.orgId,
          provider: "stripe",
          direction: "inbound",
          operation: "subscription.mock_activated",
          response: { plan: input.plan },
          success: true,
        });
        await writeAudit(
          tx,
          ctx.orgId,
          "billing.plan_change",
          "subscription",
          ctx.orgId,
          undefined,
          { plan: input.plan, status: "active" },
        );
      });
      return row;
    }),
});
