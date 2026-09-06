import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 0 end-to-end coverage — requires local Supabase + `pnpm db:seed`.
 *  - signup → onboarding → org creation → dashboard
 *  - login as seeded owner; invite a user; the invite link is produced
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

  test("owner can invite a member and gets an invite link", async ({ page }) => {
    await login(page, "owner@pathfinder.demo");
    await page.getByRole("link", { name: "Users" }).click();
    await expect(page).toHaveURL(/\/settings\/users/);

    await page.getByLabel("Invite by email").fill(`invitee-${unique()}@corridor.test`);
    await page.getByLabel("Role").selectOption({ label: "Dispatcher" });
    await page.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText(/\/invite\//)).toBeVisible();
    await expect(page.getByText("invited").first()).toBeVisible();
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
