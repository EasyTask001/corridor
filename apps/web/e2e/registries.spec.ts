import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 1 — registries + rule-based compliance alerts.
 * Requires local Supabase + `pnpm db:seed`.
 */

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

const isoDaysFromNow = (d: number) => {
  const x = new Date();
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

test.describe("registries", () => {
  test("seeded registries render with expiry chips", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/parties/drivers");
    await expect(page.getByRole("heading", { name: "Drivers" })).toBeVisible();
    await expect(page.getByText("Gurpreet Singh")).toBeVisible();
    await expect(page.getByText("overdue").first()).toBeVisible(); // Amrit Kaur's expired license

    await page.getByLabel("Search").fill("Reyes");
    await expect(page.getByText("Marcus Reyes")).toBeVisible();
    await expect(page.getByText("Gurpreet Singh")).toHaveCount(0);
  });

  test("creating a driver with an expiring license raises an alert; renewing resolves it", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    const suffix = unique().toUpperCase();
    const last = `Tester${suffix}`;

    await page.goto("/parties/drivers");
    await page.getByRole("button", { name: "New driver" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("First name").fill("Ada");
    await dialog.getByLabel("Last name").fill(last);
    await dialog.getByLabel("License number").fill(`LIC-${suffix}`);
    await dialog.getByLabel("License province/state").fill("on");
    await dialog.getByLabel("License expiry").fill(isoDaysFromNow(7)); // critical
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`Ada ${last}`)).toBeVisible();

    // Alert generated on save
    await page.goto("/alerts");
    const row = page.locator("div.panel > div", {
      hasText: `Driver's license expires in 7 days — Ada ${last}`,
    });
    await expect(row).toBeVisible();
    await expect(row.getByText("critical")).toBeVisible();

    // Renew license → alert auto-resolves
    await page.goto("/parties/drivers");
    await page.getByLabel("Search").fill(last);
    await page.getByRole("button", { name: "Edit" }).first().click();
    await page.getByRole("dialog").getByLabel("License expiry").fill(isoDaysFromNow(400));
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.goto("/alerts");
    await expect(page.getByText(`— Ada ${last}`)).toHaveCount(0);
    await page.getByRole("button", { name: "Resolved" }).click();
    await expect(page.getByText(`Driver's license expires in 7 days — Ada ${last}`)).toBeVisible();
  });

  test("a driver's travel documents are recorded on their own tab", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/parties/drivers");
    await page.getByLabel("Search").fill("Reyes");
    await page.getByRole("button", { name: "Edit" }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Travel documents" }).click();
    // Seeded: Marcus Reyes travels on a passport (primary) plus a FAST card.
    await expect(dialog.getByText("US8871220")).toBeVisible();
    await expect(dialog.getByText("FAST-77014")).toBeVisible();

    const number = `NX-${unique().toUpperCase()}`;
    await dialog.getByRole("button", { name: "Add document" }).click();
    await dialog.getByLabel("Document type").selectOption("nexus");
    await dialog.getByLabel("Document number").fill(number);
    await dialog.getByLabel("Issuing country").fill("us");
    await dialog.getByLabel("Expires on").fill(isoDaysFromNow(700));
    await dialog.getByRole("button", { name: "Save document" }).click();

    await expect(dialog.getByText("NEXUS card")).toBeVisible();
    await expect(dialog.getByText(number)).toBeVisible();

    // …and it can be taken off again.
    const row = dialog.locator("tr", { hasText: number });
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(dialog.getByText(number)).toHaveCount(0);
  });

  test("duplicate unit number is rejected with a friendly message", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/parties/trucks");
    await page.getByRole("button", { name: "New truck" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Unit number").fill("T-101"); // seeded
    await dialog.locator("#trucks-plateNumber").fill("DUP123");
    await dialog.getByLabel("Plate province/state").fill("ON");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText(/already exists/)).toBeVisible();
  });

  test("read-only user sees registries without edit controls", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    await page.goto("/parties/partners");
    await expect(page.getByText("Maple Ridge Steel Ltd")).toBeVisible();
    await expect(page.getByRole("button", { name: "New partner" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);

    await page.goto("/alerts");
    await expect(page.getByRole("heading", { name: "Compliance alerts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Re-run checks" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
  });

  test("owner can acknowledge and resolve an alert", async ({ page }) => {
    await login(page, "owner@pathfinder.demo");
    // Self-contained: create a truck with expired insurance so the alert is fresh every run.
    const unit = `T-ACK-${unique().toUpperCase()}`;
    await page.goto("/parties/trucks");
    await page.getByRole("button", { name: "New truck" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Unit number").fill(unit);
    await dialog.locator("#trucks-plateNumber").fill("ACK123");
    await dialog.getByLabel("Plate province/state").fill("ON");
    await dialog.getByLabel("Insurance expiry").fill(isoDaysFromNow(-2));
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto("/alerts");
    await page.getByRole("button", { name: "Re-run checks" }).click();
    const row = page.locator("div.panel > div", {
      hasText: `Insurance expired 2 days ago — Truck ${unit}`,
    });
    await expect(row.getByRole("button", { name: "Acknowledge" })).toBeVisible();
    await row.getByRole("button", { name: "Acknowledge" }).click();
    await expect(row.getByText("acknowledged", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
  });

  test("bulk-deactivates two drivers from the list toolbar", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    const suffix = Date.now().toString(36).toUpperCase();
    const last = `Bulk${suffix}`;
    await page.goto("/parties/drivers");
    for (const first of ["One", "Two"]) {
      await page.getByRole("button", { name: "New driver" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("First name").fill(first);
      await dialog.getByLabel("Last name").fill(last);
      await dialog.getByLabel("License number").fill(`LIC-${suffix}-${first}`);
      await dialog.getByLabel("License province/state").fill("ON");
      await dialog.getByLabel("License expiry").fill(isoDaysFromNow(400));
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await page.getByLabel("Search").fill(last);
    await expect(page.getByText(`One ${last}`)).toBeVisible();
    await expect(page.getByText(`Two ${last}`)).toBeVisible();
    await page.getByLabel("Select all on this page").check();
    await expect(page.getByRole("group", { name: "Selected rows" })).toContainText("2 selected");
    await page.getByRole("button", { name: "Deactivate selected" }).click();
    await expect(page.getByRole("group", { name: "Selected rows" })).toHaveCount(0);
    await expect(page.getByText("inactive")).toHaveCount(2);
  });
});
