import { expect, test, type Page } from "@playwright/test";

/**
 * In-bond monitor (migration 0026): the seeded IT move gets its arrival sent
 * to customs (mock gateway) and the event lands in the record's drawer; an
 * external shipment can be recorded and closed.
 * Requires local Supabase + `pnpm db:seed`.
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("in-bond", () => {
  test("send arrival on the seeded record → event row appears; status check answers", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/in-bond");
    await expect(page.getByRole("heading", { name: "In-bond" })).toBeVisible();
    const row = page.getByRole("row", { name: /PFTRPAPS90010/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("Open")).toBeVisible();

    await row.getByRole("button", { name: "Send arrival" }).click();
    await expect(row.getByText("Arrival sent")).toBeVisible();

    await row.getByRole("button", { name: "PFTRPAPS90010" }).click();
    const drawer = page.getByLabel("In-bond events");
    await expect(drawer.getByText(/^Arrival sent · ref /)).toBeVisible();

    await row.getByRole("button", { name: "Check status" }).click();
    await expect(row.getByText("Arrived")).toBeVisible();
    await expect(drawer.getByText(/Customs: arrived/)).toBeVisible();
  });

  test("record an external shipment, put it on the monitor, then close it", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/in-bond?tab=external");
    const control = `EXT${Date.now().toString(36).toUpperCase()}`;
    await page.getByRole("button", { name: "Add external shipment" }).click();
    const form = page.getByRole("form", { name: "New external shipment" });
    await form.getByLabel("Originating control number").fill(control);
    await form.getByLabel("Originating carrier code").fill("ABCD");
    await form.getByLabel("Description").fill("Crates in bond");
    await form.getByRole("button", { name: "Add external shipment" }).click();
    const row = page.getByRole("row", { name: new RegExp(control) });
    await expect(row).toBeVisible();
    await expect(row.getByText("not on monitor")).toBeVisible();

    await page.goto("/in-bond");
    await page.getByRole("button", { name: "Add in-bond record" }).click();
    const rec = page.getByRole("form", { name: "New in-bond record" });
    await rec.getByLabel("Shipment").selectOption({ label: `${control} · ACE` });
    await rec.getByLabel("Bond number (9 digits)").fill("300445566");
    await rec.getByRole("button", { name: "Add record" }).click();
    await expect(page.getByRole("row", { name: new RegExp(control) })).toBeVisible();

    await page.goto("/in-bond?tab=external");
    await page
      .getByRole("row", { name: new RegExp(control) })
      .getByRole("button", { name: "Close" })
      .click();
    await expect(
      page.getByRole("row", { name: new RegExp(control) }).getByText("closed"),
    ).toBeVisible();
  });
});
