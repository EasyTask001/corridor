import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 4 — Document intelligence: upload → background extraction → human
 * review → apply to a draft movement; low-confidence alerting; role gating.
 * Fixtures use the ".mock." filename hook so runs are deterministic even when
 * a real model key is configured.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function newDraft(page: Page) {
  await page.goto("/movements");
  await page.getByRole("button", { name: "New ACE movement" }).click();
  await expect(page).toHaveURL(/\/movements\/[0-9a-f-]{36}/);
  const number = (await page
    .getByRole("heading", { name: /ACE-\d{2}-\d{5}/ })
    .textContent())!.match(/ACE-\d{2}-\d{5}/)![0];
  return { url: page.url(), number };
}

test.describe("document intelligence", () => {
  test("upload → extract → review → apply lines to a draft movement", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    const draft = await newDraft(page);

    await page.goto("/documents");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await page
      .getByLabel("Attach to movement (optional)")
      .selectOption({ label: new RegExp(draft.number).source ? undefined : "" })
      .catch(() => {});
    // select by number text
    const opt = await page
      .getByLabel("Attach to movement (optional)")
      .locator("option", { hasText: draft.number })
      .getAttribute("value");
    await page.getByLabel("Attach to movement (optional)").selectOption(opt!);
    const rows = page.locator("tr", { hasText: "bol-steel.mock.txt" });
    const before = await rows.count();
    await page.getByLabel("File").setInputFiles(fixture("bol-steel.mock.txt"));
    await expect(rows).toHaveCount(before + 1); // wait for OUR row (newest first)
    const row = rows.first();
    // background job → extracted (request-tail worker + polling)
    await expect(row.getByText("review", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/9[0-9]%/)).toBeVisible();
    await expect(row.getByText("2", { exact: true })).toBeVisible(); // 2 lines
    await expect(row.getByRole("link", { name: draft.number })).toBeVisible(); // attached

    await row.getByRole("link", { name: "Review" }).click();
    await expect(page.getByRole("heading", { name: /bol-steel\.mock\.txt/ })).toBeVisible();
    await expect(page.getByText("Detected: bol")).toBeVisible();
    await expect(page.getByText("Maple Ridge Steel Ltd").first()).toBeVisible();
    // partner auto-matched from name
    await expect(page.getByLabel("Match to partner").first()).toHaveValue(/[0-9a-f-]{36}/);
    await expect(page.getByLabel("Line 1 HS code")).toHaveValue("7208.10");
    await expect(page.getByLabel("Line 2 weight")).toHaveValue("4000");

    // reviewer corrects a value before applying, targets the draft explicitly
    await page.getByLabel("Line 2 quantity", { exact: true }).fill("4");
    await page.getByLabel("Line 1 quantity unit").selectOption("Coil");
    await page.getByLabel("Line 2 quantity unit").selectOption("Coil");
    const reference = `PAPS${Date.now().toString(36).toUpperCase()}`;
    await page.getByLabel("Control reference").fill(reference);
    const target = page.getByLabel("Apply to movement");
    await expect(target).toHaveValue(opt!); // pre-selected from the attachment

    await page.getByRole("button", { name: /Confirm & create a shipment with 2 lines/ }).click();

    // The reviewed lines land on a new draft shipment, on the chosen movement.
    await expect(page).toHaveURL(/\/shipments\/[0-9a-f-]{36}/);
    await expect(page.getByText("Hot-rolled steel coils")).toBeVisible();
    await expect(page.getByText("Galvanized sheet, coils")).toBeVisible();

    await page.goto(draft.url);
    await page.getByRole("button", { name: /^Shipments/ }).click();
    await expect(
      page.getByText("Maple Ridge Steel Ltd → Great Lakes Fabrication Inc").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: `PFTR${reference}` }).click();
    await expect(page.getByText("AI 9")).toHaveCount(2); // per-line AI confidence chips
    const tl = page.getByRole("list", { name: "Movement timeline" });
    await expect(tl.getByText(/Applied 2 commodity line/)).toBeVisible();
    await expect(tl.getByText(/AI flag: Extracted 2 line/)).toBeVisible();

    await page.goto("/documents");
    await expect(
      page.locator("tr", { hasText: "bol-steel.mock.txt" }).first().getByText("applied"),
    ).toBeVisible();
  });

  test("low-confidence extraction raises a review alert and highlights fields", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/documents");
    const rows = page.locator("tr", { hasText: "bol-partial.mock.txt" });
    const before = await rows.count();
    await page.getByLabel("File").setInputFiles(fixture("bol-partial.mock.txt"));
    await expect(rows).toHaveCount(before + 1);
    const row = rows.first();
    await expect(row.getByText("review", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/[1-6][0-9]%/)).toBeVisible(); // < 70%

    await page.goto("/alerts");
    await expect(page.getByText(/Review needed: bol-partial\.mock\.txt/).first()).toBeVisible();

    await page.goto("/documents");
    await page
      .locator("tr", { hasText: "bol-partial.mock.txt" })
      .first()
      .getByRole("link", { name: "Review" })
      .click();
    await expect(page.getByText("not found", { exact: true })).toBeVisible(); // consignee
    await expect(page.getByRole("list", { name: "Extractor notes" })).toContainText(
      /HS code missing/,
    );
    await expect(page.getByLabel("Line 1 weight")).toHaveValue("");
  });

  test("read-only user can see documents but neither upload nor review", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    await page.goto("/documents");
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(page.getByLabel("File")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Review" })).toHaveCount(0);
  });
});
