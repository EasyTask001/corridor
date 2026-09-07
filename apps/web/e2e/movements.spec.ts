import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Phase 2 — Movement Builder: full walk-through draft → sent → accepted →
 * released → arrived with a correctly attributed timeline row per step,
 * validation gating, edit lock, amendment, and role gating.
 * Requires local Supabase + `pnpm db:seed`.
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Select an <option> by partial visible text (option labels may include variable dates). */
async function selectByText(select: Locator, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  if (!value) throw new Error(`option containing "${text}" not found`);
  await select.selectOption(value);
}

const localDateTime = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** A control reference no other run has used, so the unique control number holds. */
const controlReference = () => `PAPS${Date.now().toString(36).toUpperCase()}`;

/** Create a new ACE movement and fill every step so it passes validation. Returns its URL. */
async function buildReadyMovement(page: Page) {
  await page.goto("/movements");
  await page.getByRole("button", { name: "New ACE movement" }).click();
  await expect(page).toHaveURL(/\/movements\/[0-9a-f-]{36}/);
  await page.getByLabel("Trip number").fill("E2E-TRIP");
  await page.getByLabel("Port of entry").fill("3801");
  // The port catalogue is imported from CBP's CSV, so the name is theirs.
  await page.getByRole("button", { name: /^3801 — DETROIT/ }).click();
  await page.getByLabel("Estimated crossing").fill(localDateTime(2));
  await page.getByRole("button", { name: "Save trip" }).click();
  await expect(page.getByText(/DETROIT · ETA/)).toBeVisible();

  await page.getByRole("button", { name: /^Truck/ }).click();
  await page.getByLabel("Truck", { exact: true }).selectOption({ label: "T-101 · AB12345" });
  await page.getByRole("button", { name: /^Crew/ }).click();
  await selectByText(page.getByLabel("Driver", { exact: true }), "Singh, Gurpreet");
  await page.getByRole("button", { name: /^Trailer/ }).click();
  await page.getByLabel("Trailer", { exact: true }).selectOption({ label: "TR-501 · dry van" });

  await addShipmentWithLine(page, controlReference());

  await page.getByRole("button", { name: /^Seals/ }).click();
  await page.getByLabel("Seal number").fill("SL-E2E-1");
  await page.getByRole("button", { name: "Add seal" }).click();
  await expect(page.getByText("SL-E2E-1")).toBeVisible();

  await page.getByRole("button", { name: /^Review/ }).click();
  await expect(page.getByText("All checks pass")).toBeVisible();
  return page.url();
}

/** Add a shipment to the open movement and give it one complete commodity line. */
async function addShipmentWithLine(page: Page, reference: string) {
  await page.getByRole("button", { name: /^Shipments/ }).click();
  await page.getByRole("button", { name: "Add shipment", exact: true }).click();
  const shipment = page.getByRole("form", { name: "New shipment" });
  await shipment.getByLabel("Control reference").fill(reference);
  await shipment.getByLabel("Shipper").selectOption({ label: "Maple Ridge Steel Ltd" });
  await shipment.getByLabel("Consignee").selectOption({ label: "Great Lakes Fabrication Inc" });
  await shipment.getByRole("button", { name: "Save shipment" }).click();

  const controlNumber = `PFTR${reference}`;
  const row = page.getByRole("button", { name: controlNumber });
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("button", { name: "+ Add commodity line" }).click();
  const line = page.getByRole("form", { name: "New commodity line" });
  await line.getByLabel("Commodity description").fill("Hot-rolled steel coils");
  await line.getByLabel("HS code").fill("7208.10");
  await line.getByLabel("Weight", { exact: true }).fill("21500");
  await line.getByLabel("Quantity", { exact: true }).fill("12");
  await line.getByLabel("Quantity unit").selectOption("Coil");
  await line.getByLabel("Value", { exact: true }).fill("48000");
  await line.getByLabel("Currency").selectOption("USD");
  await line.getByLabel("Country of origin").fill("CA");
  await line.getByRole("button", { name: "Save line" }).click();
  await expect(page.getByText("Hot-rolled steel coils")).toBeVisible();
  return controlNumber;
}

const heading = (page: Page) => page.getByRole("heading", { name: /ACE-\d{2}-\d{5}/ });
const timeline = (page: Page) => page.getByRole("list", { name: "Movement timeline" });

test.describe("movement builder", () => {
  test("board lists every status chip and filters by status", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/movements");
    for (const s of [
      "draft",
      "sent",
      "accepted",
      "held",
      "released",
      "rejected",
      "arrived",
      "cancelled",
    ]) {
      await expect(
        page.getByRole("link", { name: new RegExp(`^${s}\\s+\\d+$`, "i") }),
      ).toBeVisible();
    }
    await page.getByRole("link", { name: /^held/i }).click();
    await expect(page).toHaveURL(/status=held/);
    await expect(page.getByRole("cell", { name: "HELD" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "DRAFT" })).toHaveCount(0);
  });

  test("suggests a historical trip and applies it only after confirmation", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/movements");
    await page.getByRole("button", { name: "New ACE movement" }).click();
    await page.getByRole("button", { name: "Suggest from history" }).click();

    await expect(page.getByText("AI suggested · not applied")).toBeVisible();
    await expect(page.getByText(/Reuse the lane from ACE-/)).toBeVisible();
    await page.getByRole("button", { name: "Apply suggestion" }).click();
    await expect(page.getByText("AI suggested · not applied")).toHaveCount(0);
    await expect(page.getByText(/No port selected/)).toHaveCount(0);

    // The lane and the equipment are applied; shipments are not — a control
    // number cannot be cloned from an earlier trip.
    await page.getByRole("button", { name: /^Truck/ }).click();
    await expect(page.getByLabel("Truck", { exact: true })).not.toHaveValue("");
    await page.getByRole("button", { name: /^Shipments/ }).click();
    await expect(page.getByText("No shipments on this movement yet.")).toBeVisible();
  });

  test("walk a movement through every transition with attributed timeline rows", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/movements");
    await page.getByRole("button", { name: "New ACE movement" }).click();
    await expect(heading(page).getByText("draft")).toBeVisible();
    // Transmit is disabled while blocking issues exist
    const transmit = page.getByRole("button", { name: "Transmit to CBP" });
    await expect(transmit).toBeDisabled();

    await buildReadyMovement(page);
    await expect(transmit).toBeEnabled();
    await transmit.click();
    await expect(heading(page).getByText("sent")).toBeVisible();

    // Edit lock: no save buttons while sent
    await page.getByRole("button", { name: /^Trip/ }).click();
    await expect(page.getByRole("button", { name: "Save trip" })).toHaveCount(0);
    await expect(page.getByLabel("Trip number")).toBeDisabled();

    // Customs simulation: accepted → released; dispatcher marks arrived
    await page.getByRole("button", { name: "accepted", exact: true }).click();
    await expect(heading(page).getByText("accepted")).toBeVisible();
    await page.getByRole("button", { name: "released", exact: true }).click();
    await expect(heading(page).getByText("released")).toBeVisible();
    await page.getByRole("button", { name: "Mark arrived" }).click();
    await expect(heading(page).getByText("arrived")).toBeVisible();

    // Timeline attribution
    const tl = timeline(page);
    await expect(tl.getByText("released → arrived")).toBeVisible();
    await expect(tl.getByText("accepted → released")).toBeVisible();
    await expect(tl.getByText("sent → accepted")).toBeVisible();
    await expect(tl.getByText("draft → sent")).toBeVisible();
    await expect(tl.getByText(/Customs accepted.*simulated/)).toBeVisible();
    await expect(tl.getByText(/^User · Dana Dispatcher/).first()).toBeVisible();
    await expect(tl.getByText(/^Customs ·/).first()).toBeVisible();

    // Terminal: no actions left
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  });

  test("rejected manifest becomes editable again and can be re-transmitted", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await buildReadyMovement(page);
    await page.getByRole("button", { name: "Transmit to CBP" }).click();
    await expect(heading(page).getByText("sent")).toBeVisible();
    await page.getByRole("button", { name: "rejected", exact: true }).click();
    await expect(heading(page).getByText("rejected")).toBeVisible();

    await page.getByRole("button", { name: /^Trip/ }).click();
    await expect(page.getByLabel("Trip number")).toBeEnabled();
    await page.getByLabel("Trip number").fill("E2E-TRIP-FIXED");
    await page.getByRole("button", { name: "Save trip" }).click();

    const transmit = page.getByRole("button", { name: "Transmit to CBP" });
    await expect(transmit).toBeEnabled();
    await transmit.click();
    await expect(heading(page).getByText("sent")).toBeVisible();
    await expect(timeline(page).getByText("rejected → sent")).toBeVisible();
    await expect(timeline(page).getByText("sent → rejected")).toBeVisible();
  });

  test("amending an accepted manifest re-transmits and records the diff", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await buildReadyMovement(page);
    await page.getByRole("button", { name: "Transmit to CBP" }).click();
    await page.getByRole("button", { name: "accepted", exact: true }).click();
    await expect(heading(page).getByText("accepted")).toBeVisible();

    await page.getByRole("button", { name: "Amend" }).click();
    await page.getByLabel("Reason").fill("Driver swapped at yard");
    await selectByText(page.getByLabel("Driver"), "Thompson, Dale");
    await page.getByRole("button", { name: "Submit amendment" }).click();
    await expect(heading(page).getByText("sent")).toBeVisible();
    await expect(timeline(page).getByText("Amendment #1: Driver swapped at yard")).toBeVisible();
    await expect(timeline(page).getByText("accepted → sent")).toBeVisible();
    await page.getByRole("button", { name: /^Review/ }).click();
    await expect(page.getByText(/driverId:/)).toBeVisible();

    // Customs accepts the amendment → amendment row marked accepted
    await page.getByRole("button", { name: "accepted", exact: true }).click();
    await expect(heading(page).getByText("accepted")).toBeVisible();
    await expect(page.getByText(/#1 · accepted/)).toBeVisible();
  });

  test("read-only user sees the movement but no controls", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    await page.goto("/movements");
    await expect(page.getByRole("button", { name: "New ACE movement" })).toHaveCount(0);
    await page
      .getByRole("link", { name: /AC[EI]-\d{2}-\d{5}/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: /AC[EI]-/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Transmit/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(page.getByLabel("Add note")).toHaveCount(0);
  });
});
