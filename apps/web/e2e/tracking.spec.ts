import { expect, test } from "@playwright/test";

/**
 * Public PAPS/PARS lookup (migration 0027): no session, gated by carrier code
 * + control number, minimal answer, 10 lookups a minute per address.
 * Requires local Supabase + `pnpm db:seed`.
 */
test.describe("public tracking", () => {
  test("a seeded control number shows its status; a wrong carrier code is not found", async ({
    page,
  }) => {
    await page.goto("/track");
    await expect(page.getByRole("heading", { name: "Check a PAPS / PARS" })).toBeVisible();
    await page.getByLabel("Carrier code").fill("pftr");
    await page.getByLabel("PAPS / PARS control number").fill("PFTRPAPS90001");
    await page.getByRole("button", { name: "Check status" }).click();
    const card = page.getByLabel("Shipment status");
    await expect(card).toBeVisible();
    await expect(card.getByText("Not yet filed")).toBeVisible();

    await page.getByLabel("Carrier code").fill("NBFL");
    await page.getByRole("button", { name: "Check status" }).click();
    await expect(page.getByRole("status")).toHaveText(/No filing matches/);
  });

  test("the eleventh lookup in a minute is refused", async ({ page }) => {
    await page.goto("/track");
    await page.getByLabel("Carrier code").fill("PFTR");
    await page.getByLabel("PAPS / PARS control number").fill("PFTRPAPS90002");
    const button = page.getByRole("button", { name: "Check status" });
    for (let i = 0; i < 10; i++) {
      await button.click();
      await expect(page.getByLabel("Shipment status")).toBeVisible();
    }
    await button.click();
    // Scoped to <main>: Next.js mounts its own route announcer with role="alert".
    await expect(page.locator("main").getByRole("alert")).toHaveText(/Too many lookups/);
  });
});
