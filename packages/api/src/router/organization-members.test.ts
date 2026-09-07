/**
 * `organization.members.invite` — who may invite, which roles they may hand
 * out, and what the invite row/audit record look like.
 *
 * (`organization.sso.*` has its own suite in ../sso.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@corridor/domain";
import type * as AuditModule from "../services/audit";
import { TEST_ORG_ID, TEST_USER_ID, createMockCaller, type Row } from "../test/mock-context";

const writeAudit = vi.fn();
vi.mock("../services/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof AuditModule>()),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { organizationRouter } = await import("./organization");
const { createCallerFactory } = await import("../trpc");
const createCaller = createCallerFactory(organizationRouter);

const ROLE_ID = "99999999-1111-4111-8111-999999999999";

const dispatcherRole = (over: Row = {}): Row => ({
  id: ROLE_ID,
  organizationId: null,
  name: "Dispatcher",
  isSystem: true,
  ...over,
});

/** Permission keys the invited role carries, in the shape the join projects. */
const rolePermissionRows = (keys: PermissionKey[]) => keys.map((key) => ({ roleId: ROLE_ID, key }));

const OWNER: PermissionKey[] = [
  "organization.members.manage",
  "organization.members.read",
  "movement.read",
  "movement.write",
  "movement.transmit_to_customs",
];

function caller(
  over: {
    permissions?: PermissionKey[];
    roles?: Row[];
    grants?: PermissionKey[];
    conflict?: boolean;
  } = {},
) {
  return createMockCaller(createCaller, {
    permissions: over.permissions ?? OWNER,
    rows: {
      roles: over.roles ?? [dispatcherRole()],
      rolePermissions: rolePermissionRows(over.grants ?? ["movement.read", "movement.write"]),
      organizationMembers: [],
    },
    insertConflicts: over.conflict ? ["organizationMembers"] : [],
  });
}

const INVITE = { email: "new.dispatcher@corridor.test", roleId: ROLE_ID };

beforeEach(() => writeAudit.mockReset());

describe("organization.members.invite", () => {
  it("creates an invited membership and returns a link carrying the token", async () => {
    const { caller: api, db } = caller();

    const result = await api.members.invite(INVITE);

    const [member] = db.table("organizationMembers");
    expect(member).toMatchObject({
      organizationId: TEST_ORG_ID,
      roleId: ROLE_ID,
      status: "invited",
      invitedEmail: INVITE.email,
      invitedBy: TEST_USER_ID,
    });
    expect(result.invitePath).toBe(`/invite/${member!.inviteToken as string}`);
    expect(String(member!.inviteToken)).toHaveLength(32); // 24 random bytes, base64url
    // Seven days, give or take the clock tick between the two `Date.now()`s.
    const ttlDays = (result.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(6.9);
    expect(ttlDays).toBeLessThanOrEqual(7);
  });

  it("audits the invitation with the email and role, and never the token", async () => {
    const { caller: api, db } = caller();

    const result = await api.members.invite(INVITE);

    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      TEST_ORG_ID,
      "member.invite",
      "organization_member",
      result.memberId,
      null,
      { email: INVITE.email, roleId: ROLE_ID, status: "invited" },
    );
    const token = db.table("organizationMembers")[0]!.inviteToken as string;
    expect(JSON.stringify(writeAudit.mock.calls[0])).not.toContain(token);
  });

  it("is CONFLICT when the email is already invited or a member", async () => {
    const { caller: api, db } = caller({ conflict: true });

    await expect(api.members.invite(INVITE)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Already invited or a member",
    });
    expect(db.table("organizationMembers")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a role from another organization as an unknown role", async () => {
    const { caller: api, db } = caller({ roles: [] });

    await expect(api.members.invite(INVITE)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Unknown role",
    });
    expect(db.table("organizationMembers")).toHaveLength(0);
  });

  it("refuses to grant a permission the inviter does not hold (privilege escalation)", async () => {
    const { caller: api, db } = caller({
      permissions: ["organization.members.manage", "movement.read"],
      grants: ["movement.read", "billing.manage"],
    });

    await expect(api.members.invite(INVITE)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Cannot grant permissions you do not hold: billing.manage",
    });
    expect(db.table("organizationMembers")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("requires organization.members.manage — reading the member list is not enough", async () => {
    const { caller: api, db } = caller({ permissions: ["organization.members.read"] });

    await expect(api.members.invite(INVITE)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: organization.members.manage",
    });
    expect(db.table("organizationMembers")).toHaveLength(0);
  });
});
