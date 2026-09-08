/**
 * `organization.sso.*` — the Enterprise gate, and the resolver behaviour that
 * sits between Supabase Auth and the local mirror.
 *
 * Supabase Auth is stubbed (the wrapper has its own tests against a canned
 * fetch) and the transaction is a hand-written fake, so what is under test here
 * is the router's own logic: which wrapper call it makes, what it writes, what
 * it audits, how it maps a rejection, and what it undoes when the mirror write
 * fails after a provider has already been created upstream.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@corridor/auth";
import type { SubscriptionPlan } from "@corridor/domain";
import { SsoProviderError } from "@corridor/integrations";
import type * as IntegrationsModule from "@corridor/integrations";
import type { RlsTransaction } from "@corridor/db";
import type { Context } from "./context";
import type * as AuditModule from "./services/audit";

const createSsoProvider = vi.fn();
const updateSsoProvider = vi.fn();
const deleteSsoProvider = vi.fn();

vi.mock("@corridor/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationsModule>()),
  createSsoProvider: (...args: unknown[]) => createSsoProvider(...args),
  updateSsoProvider: (...args: unknown[]) => updateSsoProvider(...args),
  deleteSsoProvider: (...args: unknown[]) => deleteSsoProvider(...args),
}));

const writeAudit = vi.fn();
vi.mock("./services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { organizationRouter } = await import("./router/organization");
const { createCallerFactory } = await import("./trpc");

const PAST_THE_GATE = "reached the resolver";
const ORG = "o1";
const METADATA_XML = "<EntityDescriptor>…secret-ish, and enormous…</EntityDescriptor>";
const CONFIGURE = {
  metadataUrl: "https://idp.acme.test/metadata",
  domains: ["acme.test"],
  enforced: true,
};

interface SsoRow {
  organizationId: string;
  providerId: string;
  domains: string[];
  enforced: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function row(over: Partial<SsoRow> = {}): SsoRow {
  return {
    organizationId: ORG,
    providerId: "11111111-2222-3333-4444-555555555555",
    domains: ["acme.test"],
    enforced: false,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

/** Just enough of a Drizzle transaction for the three statements the router runs. */
function fakeTx(state: { row: SsoRow | null; failWrite?: boolean; failDelete?: boolean }) {
  return {
    query: { organizationSso: { findFirst: async () => state.row ?? undefined } },
    // `configure` takes an advisory lock and re-reads the row FOR UPDATE
    // before writing (the TOCTOU guard around the GoTrue round-trip).
    execute: async () => [],
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => (state.row ? [{ providerId: state.row.providerId }] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Omit<SsoRow, "createdAt" | "updatedAt">) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (state.failWrite) throw new Error("row-level security violation");
            state.row = row({ ...values, updatedAt: new Date("2026-09-02T00:00:00Z") });
            return [state.row];
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (state.failDelete) return [];
          state.row = null;
          return [{ organizationId: ORG }];
        },
      }),
    }),
  } as unknown as RlsTransaction;
}

function caller(
  plan: SubscriptionPlan,
  permissions: string[] = ["organization.manage"],
  state?: { row: SsoRow | null; failWrite?: boolean; failDelete?: boolean },
) {
  const session: Session = {
    user: { id: "u1", email: "owner@acme.test", displayName: null },
    memberships: [
      {
        organizationId: ORG,
        organizationName: "Acme",
        roleId: "r1",
        roleName: "Owner",
        status: "active",
      },
    ],
    activeOrganizationId: ORG,
    plan,
    permissions: new Set(permissions) as Session["permissions"],
    accessToken: "jwt",
  };
  const ctx: Context = {
    session,
    supabase: {} as never,
    db: {} as never,
    headers: new Headers(),
    rls: state
      ? ((<T>(fn: (tx: RlsTransaction) => Promise<T>) => fn(fakeTx(state))) as Context["rls"])
      : async () => {
          throw new Error(PAST_THE_GATE);
        },
  };
  return createCallerFactory(organizationRouter)(ctx);
}

beforeEach(() => {
  createSsoProvider.mockReset();
  updateSsoProvider.mockReset();
  deleteSsoProvider.mockReset().mockResolvedValue({ mode: "saml" });
  writeAudit.mockReset();
});

describe("organization.sso enterprise gate", () => {
  for (const plan of ["trial", "starter", "professional"] as const) {
    it(`refuses to configure SSO for a ${plan} tenant`, async () => {
      await expect(
        caller(plan).sso.configure({
          metadataUrl: "https://idp.acme.test/metadata",
          domains: ["acme.test"],
          enforced: false,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "SSO requires the Enterprise plan" });
      expect(createSsoProvider).not.toHaveBeenCalled();
    });

    /**
     * `organization_sso.enforced` survives a downgrade, so a tenant that drops
     * off Enterprise still has password sign-in blocked. Gating `get`/`remove`
     * on the plan would leave them no way to turn it off — locked out of their
     * own account with only a support ticket for a key.
     */
    it(`still lets a ${plan} tenant read and remove an existing configuration`, async () => {
      await expect(caller(plan).sso.get()).rejects.toThrow(PAST_THE_GATE);

      const state = { row: row({ enforced: true }) };
      const result = await caller(plan, ["organization.manage"], state).sso.remove();
      expect(result).toEqual({ organizationId: ORG });
      expect(deleteSsoProvider).toHaveBeenCalledTimes(1);
      expect(state.row).toBeNull();
    });
  }

  it("lets an enterprise tenant through to the resolver", async () => {
    await expect(caller("enterprise").sso.get()).rejects.toThrow(PAST_THE_GATE);
  });

  it("still requires organization.manage on every operation, on every plan", async () => {
    await expect(caller("enterprise", ["organization.read"]).sso.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: organization.manage",
    });
    await expect(caller("starter", ["organization.read"]).sso.remove()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: organization.manage",
    });
  });
});

describe("organization.sso.get", () => {
  it("returns the row plus how this deployment is configured", async () => {
    const state = { row: row({ enforced: true }) };
    const result = await caller("enterprise", ["organization.manage"], state).sso.get();
    expect(result.config).toMatchObject({
      providerId: state.row.providerId,
      domains: ["acme.test"],
      enforced: true,
      mode: "saml",
    });
    expect(["saml", "mock"]).toContain(result.instanceMode);
  });

  it("reports a mock provider as mock", async () => {
    const state = { row: row({ providerId: "mock-sso-abc" }) };
    const result = await caller("enterprise", ["organization.manage"], state).sso.get();
    expect(result.config?.mode).toBe("mock");
  });

  it("returns null when nothing is configured", async () => {
    const result = await caller("enterprise", ["organization.manage"], { row: null }).sso.get();
    expect(result.config).toBeNull();
  });
});

describe("organization.sso.configure", () => {
  it("creates a provider when there is none, and mirrors it", async () => {
    createSsoProvider.mockResolvedValue({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      domains: ["acme.test"],
      entityId: "https://idp.acme.test/saml",
      mode: "saml",
    });
    const state = { row: null as SsoRow | null };

    const result = await caller("enterprise", ["organization.manage"], state).sso.configure(
      CONFIGURE,
    );

    expect(createSsoProvider).toHaveBeenCalledWith({
      metadataUrl: "https://idp.acme.test/metadata",
      metadataXml: undefined,
      domains: ["acme.test"],
    });
    expect(updateSsoProvider).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      providerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      domains: ["acme.test"],
      enforced: true,
      mode: "saml",
    });
    expect(state.row?.providerId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("re-registers the existing provider instead of creating a second one", async () => {
    const existing = row({ providerId: "existing-provider", domains: ["old.test"] });
    updateSsoProvider.mockResolvedValue({
      id: "existing-provider",
      domains: ["acme.test"],
      entityId: null,
      mode: "saml",
    });

    const result = await caller("enterprise", ["organization.manage"], {
      row: existing,
    }).sso.configure(CONFIGURE);

    expect(updateSsoProvider).toHaveBeenCalledWith("existing-provider", {
      metadataUrl: "https://idp.acme.test/metadata",
      metadataXml: undefined,
      domains: ["acme.test"],
    });
    expect(createSsoProvider).not.toHaveBeenCalled();
    expect(result.providerId).toBe("existing-provider");
  });

  it("audits the change without ever putting the metadata in the log", async () => {
    createSsoProvider.mockResolvedValue({
      id: "mock-sso-xyz",
      domains: ["acme.test"],
      entityId: null,
      mode: "mock",
    });

    await caller("enterprise", ["organization.manage"], { row: null }).sso.configure({
      metadataXml: METADATA_XML,
      domains: ["acme.test"],
      enforced: true,
    });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const [, orgId, action, entityType, entityId, before, after] = writeAudit.mock.calls[0]!;
    expect({ orgId, action, entityType, entityId, before }).toEqual({
      orgId: ORG,
      action: "organization.sso_configure",
      entityType: "organization_sso",
      entityId: ORG,
      before: null,
    });
    expect(after).toEqual({
      providerId: "mock-sso-xyz",
      domains: ["acme.test"],
      enforced: true,
    });
    expect(JSON.stringify(writeAudit.mock.calls[0])).not.toContain("EntityDescriptor");
  });

  it("carries the previous configuration into the audit `before`", async () => {
    const existing = row({ providerId: "p-old", domains: ["old.test"], enforced: false });
    updateSsoProvider.mockResolvedValue({
      id: "p-old",
      domains: ["acme.test"],
      entityId: null,
      mode: "saml",
    });

    await caller("enterprise", ["organization.manage"], { row: existing }).sso.configure(CONFIGURE);

    expect(writeAudit.mock.calls[0]![5]).toEqual({
      providerId: "p-old",
      domains: ["old.test"],
      enforced: false,
    });
  });

  it("deletes the provider it just created when the mirror write fails", async () => {
    createSsoProvider.mockResolvedValue({
      id: "orphan-provider",
      domains: ["acme.test"],
      entityId: null,
      mode: "saml",
    });

    await expect(
      caller("enterprise", ["organization.manage"], {
        row: null,
        failWrite: true,
      }).sso.configure(CONFIGURE),
    ).rejects.toThrow(/row-level security/);

    // Otherwise the provider would sit in Auth with no owner, and the retry
    // would trip GoTrue's "domain already claimed" rejection.
    expect(deleteSsoProvider).toHaveBeenCalledWith("orphan-provider");
  });

  it("does not delete an existing provider when an update's mirror write fails", async () => {
    updateSsoProvider.mockResolvedValue({
      id: "existing-provider",
      domains: ["acme.test"],
      entityId: null,
      mode: "saml",
    });

    await expect(
      caller("enterprise", ["organization.manage"], {
        row: row({ providerId: "existing-provider" }),
        failWrite: true,
      }).sso.configure(CONFIGURE),
    ).rejects.toThrow(/row-level security/);

    expect(deleteSsoProvider).not.toHaveBeenCalled();
  });

  it("maps a 4xx from Supabase Auth to BAD_REQUEST", async () => {
    createSsoProvider.mockRejectedValue(new SsoProviderError(422, "SAML Metadata URL is invalid"));
    await expect(
      caller("enterprise", ["organization.manage"], { row: null }).sso.configure(CONFIGURE),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Supabase Auth rejected the SAML configuration: SAML Metadata URL is invalid",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("maps a 5xx from Supabase Auth to BAD_GATEWAY with a hint", async () => {
    createSsoProvider.mockRejectedValue(new SsoProviderError(500, "Unexpected failure"));
    await expect(
      caller("enterprise", ["organization.manage"], { row: null }).sso.configure(CONFIGURE),
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: /is the metadata URL reachable from Auth\?/,
    });
  });

  it("rejects input that is neither a metadata URL nor XML", async () => {
    await expect(
      caller("enterprise", ["organization.manage"], { row: null }).sso.configure({
        domains: ["acme.test"],
        enforced: false,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createSsoProvider).not.toHaveBeenCalled();
  });
});

describe("organization.sso.remove", () => {
  it("removes the provider upstream, then the row, and audits it", async () => {
    const state = { row: row({ providerId: "p-live", enforced: true }) };

    await expect(
      caller("enterprise", ["organization.manage"], state).sso.remove(),
    ).resolves.toEqual({ organizationId: ORG });

    expect(deleteSsoProvider).toHaveBeenCalledWith("p-live");
    expect(state.row).toBeNull();
    const [, orgId, action, , , before, after] = writeAudit.mock.calls[0]!;
    expect({ orgId, action, after }).toEqual({
      orgId: ORG,
      action: "organization.sso_remove",
      after: null,
    });
    expect(before).toEqual({ providerId: "p-live", domains: ["acme.test"], enforced: true });
  });

  it("is NOT_FOUND when nothing is configured, and touches Auth not at all", async () => {
    await expect(
      caller("enterprise", ["organization.manage"], { row: null }).sso.remove(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deleteSsoProvider).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("refuses rather than half-removing when RLS drops the delete", async () => {
    await expect(
      caller("enterprise", ["organization.manage"], {
        row: row(),
        failDelete: true,
      }).sso.remove(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("maps an Auth rejection on delete the same way as configure", async () => {
    deleteSsoProvider.mockRejectedValue(new SsoProviderError(403, "not allowed"));
    await expect(
      caller("enterprise", ["organization.manage"], { row: row() }).sso.remove(),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
