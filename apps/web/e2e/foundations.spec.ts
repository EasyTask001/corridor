import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 0 end-to-end coverage — requires local Supabase + `pnpm db:seed`.
 *  - signup → onboarding → org creation → dashboard
 *  - login as seeded owner; invite a user; the invitee signs up and accepts
 *  - role gating: read-only user does not see Users/Billing nav, cannot edit org
 */

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe("auth + onboarding", () => {
  test("unauthenticated users are redirected to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  });

  test("signup creates a user, onboarding creates an org, dashboard renders", async ({ page }) => {
    const email = `e2e-${unique()}@corridor.test`;
    await page.goto("/signup");
    await page.getByLabel("Your name").fill("E2E Owner");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password").fill("corridor-e2e-pass");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/onboarding/);
    await page.getByLabel("Carrier name").fill(`E2E Carrier ${unique()}`);
    await page.getByLabel("SCAC (US)").fill("eecx");
    await page.getByRole("button", { name: "Create carrier" }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("EECX")).toBeVisible(); // SCAC upper-cased by schema + RPC
    await expect(page.getByText("All clear")).toBeVisible(); // fresh org: no alerts
    await expect(page.getByTestId("tile-ace")).toHaveText("0"); // monthly tiles, nothing filed yet
    await expect(page.getByLabel("Movements by month")).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible(); // owner grant
  });
});

test.describe("seeded roles", () => {
  async function login(page: Page, email: string) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("corridor-demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  }

  test("owner invites a member, the invitee signs up and accepts, the seat goes active", async ({
    page,
    browser,
  }) => {
    const email = `invitee-${unique()}@corridor.test`;
    await login(page, "owner@pathfinder.demo");
    await page.getByRole("link", { name: "Users" }).click();
    await expect(page).toHaveURL(/\/settings\/users/);

    await page.getByLabel("Invite by email").fill(email);
    await page.getByLabel("Role").selectOption({ label: "Dispatcher" });
    await page.getByRole("button", { name: "Send invite" }).click();

    const inviteLink = await page.getByText(/\/invite\//).innerText();
    expect(inviteLink).toMatch(/\/invite\/[\w-]+$/);
    await expect(page.getByRole("row", { name: new RegExp(email) })).toContainText("invited");

    // The invitee is a different person on a different machine: fresh cookies.
    const inviteeContext = await browser.newContext();
    const invitee = await inviteeContext.newPage();
    const invitePath = new URL(inviteLink).pathname;
    try {
      // Signed out, the invite link is gated like any other private route.
      await invitee.goto(invitePath);
      await expect(invitee).toHaveURL(`/login?next=${encodeURIComponent(invitePath)}`);

      // The invitee has no account yet, so they sign up and come back to it.
      await invitee.goto(`/signup?next=${encodeURIComponent(invitePath)}`);
      await invitee.getByLabel("Your name").fill("Ingrid Invitee");
      // accept_invitation() matches on the invited address, so it must be this one.
      await invitee.getByLabel("Work email").fill(email);
      await invitee.getByLabel("Password").fill("corridor-e2e-pass");
      await invitee.getByRole("button", { name: "Create account" }).click();

      await expect(invitee).toHaveURL(/\/invite\//);
      await invitee.getByRole("button", { name: "Accept invitation" }).click();
      await expect(invitee).toHaveURL(/\/dashboard/);
      // The accepted membership is the invitee's active org, not a new carrier.
      await expect(invitee.getByRole("heading", { name: "Pathfinder Trans Inc" })).toBeVisible();
    } finally {
      await inviteeContext.close();
    }

    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(email) })).toContainText("active");
  });

  test("owner can create, edit, and delete a custom role", async ({ page }) => {
    await login(page, "owner@pathfinder.demo");
    await page.getByRole("link", { name: "Roles" }).click();
    await expect(page).toHaveURL(/\/settings\/roles/);

    const name = `Border Reviewer ${unique()}`;
    await page.getByLabel("Role name").fill(name);
    await page
      .getByText("movement.read", { exact: true })
      .locator("..")
      .locator("..")
      .getByRole("checkbox")
      .check();
    await page.getByRole("button", { name: "Create role" }).click();
    await expect(page.getByText("Role created.")).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();

    await page
      .getByText("report.read", { exact: true })
      .locator("..")
      .locator("..")
      .getByRole("checkbox")
      .check();
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByText("Role saved.")).toBeVisible();
    await expect(page.getByText("2 permissions selected")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete role" }).click();
    await expect(page.getByText("Role deleted.")).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);

    await page.getByRole("link", { name: "Audit log" }).click();
    await page.getByLabel("Search actions or entities").fill("role.delete");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("role.delete", { exact: true }).first()).toBeVisible();
  });

  test("read-only user is gated out of management UI", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    // Read-Only holds every *.read key, so read pages stay visible…
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(1);
    // …but manage-only surfaces and the transmit grant are absent.
    await expect(page.getByRole("link", { name: "Roles" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Integrations" })).toHaveCount(0);
    await expect(page.getByText("movement.transmit_to_customs")).toHaveCount(0);

    await page.goto("/settings/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send invite" })).toHaveCount(0);

    await page.goto("/settings/organization");
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  });
});
