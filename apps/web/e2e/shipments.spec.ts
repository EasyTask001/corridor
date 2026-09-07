import { expect, test, type Page } from "@playwright/test";

/**
 * Shipments as a first-class entity (migration 0019): a shipment is created on
 * a movement, can be detached back into the unassigned pool, is searchable on
 * its own page, and can be re-assigned from the movement workspace.
 * Requires local Supabase + `pnpm db:seed`.
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

const controlReference = () => `PAPS${Date.now().toString(36).toUpperCase()}`;

test.describe("shipments", () => {
  test("create on a movement → unassign → assign back from the workspace", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/movements");
    await page.getByRole("button", { name: "New ACE movement" }).click();
    await expect(page).toHaveURL(/\/movements\/[0-9a-f-]{36}/);
    const movementUrl = page.url();

    // --- create
    const reference = controlReference();
    const controlNumber = `PFTR${reference}`;
    await page.getByRole("button", { name: /^Shipments/ }).click();
    await page.getByRole("button", { name: "Add shipment", exact: true }).click();
    const form = page.getByRole("form", { name: "New shipment" });
    await form.getByLabel("Control reference").fill(reference);
    await form.getByLabel("Shipper").selectOption({ label: "Maple Ridge Steel Ltd" });
    await form.getByLabel("Consignee").selectOption({ label: "Great Lakes Fabrication Inc" });
    await form.getByRole("button", { name: "Save shipment" }).click();
    await expect(page.getByRole("button", { name: controlNumber })).toBeVisible();

    // --- unassign: it leaves the movement but survives as a shipment
    await page.getByRole("button", { name: "Unassign" }).click();
    await expect(page.getByText("No shipments on this movement yet.")).toBeVisible();

    await page.goto("/shipments?unassigned=1");
    await expect(page.getByRole("link", { name: controlNumber })).toBeVisible();
    await expect(
      page.getByRole("row", { name: new RegExp(controlNumber) }).getByText("unassigned"),
    ).toBeVisible();

    // --- assign it back from the workspace
    await page.goto(movementUrl);
    await page.getByRole("button", { name: /^Shipments/ }).click();
    await page.getByRole("button", { name: "Assign existing" }).click();
    const dialog = page.getByRole("region", { name: "Assign existing shipments" });
    await dialog.getByLabel("Unassigned shipments").fill(reference);
    await dialog.getByText(controlNumber).click();
    await dialog.getByRole("button", { name: /^Assign/ }).click();
    await expect(page.getByRole("button", { name: controlNumber })).toBeVisible();
  });

  test("the shipment page edits the header and its commodity lines", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/movements");
    await page.getByRole("button", { name: "New ACE movement" }).click();
    const reference = controlReference();
    const controlNumber = `PFTR${reference}`;

    await page.getByRole("button", { name: /^Shipments/ }).click();
    await page.getByRole("button", { name: "Add shipment", exact: true }).click();
    const form = page.getByRole("form", { name: "New shipment" });
    await form.getByLabel("Control reference").fill(reference);
    await form.getByRole("button", { name: "Save shipment" }).click();
    await page.getByRole("link", { name: "Open" }).click();

    await expect(page).toHaveURL(/\/shipments\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: new RegExp(controlNumber) })).toBeVisible();

    await page.getByRole("button", { name: "Add commodity line" }).click();
    const line = page.getByRole("form", { name: "New commodity line" });
    await line.getByLabel("Commodity description").fill("Galvanized sheet, coils");
    await line.getByLabel("Weight", { exact: true }).fill("4000");
    await line.getByLabel("Quantity", { exact: true }).fill("3");
    await line.getByLabel("Quantity unit").selectOption("Coil");
    await line.getByRole("button", { name: "+ Add dangerous goods" }).click();
    await line.getByLabel("UN code 1").fill("UN1203");
    await line.getByRole("button", { name: "Save line" }).click();

    await expect(page.getByText("Galvanized sheet, coils")).toBeVisible();
    await expect(page.getByText("UN1203")).toBeVisible();
  });

  test("read-only sees the shipments list but cannot edit a shipment", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    await page.goto("/shipments");
    await expect(page.getByRole("heading", { name: "Shipments" })).toBeVisible();
    await page
      .getByRole("link", { name: /^(PFTR|7ELU)/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/shipments\/[0-9a-f-]{36}/);
    await expect(page.getByRole("button", { name: "Save shipment" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add commodity line" })).toHaveCount(0);
  });
});
