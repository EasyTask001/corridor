import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Phase 3 — integration stubs: mock customs gateway with asynchronous
 * decisions delivered by the background job queue (and pushed to the page
 * over Realtime), failure injection via trip-number hooks, the integrations
 * settings page, and mock-mode billing checkout.
 * Requires local Supabase + `pnpm db:seed` (seeded mockDelayMs = 3000).
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

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

const heading = (page: Page) => page.getByRole("heading", { name: /ACE-\d{2}-\d{5}/ });
const timeline = (page: Page) => page.getByRole("list", { name: "Movement timeline" });

/** Build a transmit-ready ACE movement with the given trip number. */
async function buildReady(page: Page, tripNumber: string) {
  await page.goto("/movements");
  await page.getByRole("button", { name: "New ACE movement" }).click();
  await expect(page).toHaveURL(/\/movements\/[0-9a-f-]{36}/);
  await page.getByLabel("Trip number").fill(tripNumber);
  await page.getByLabel("Port of entry").fill("3801");
  await page.getByRole("button", { name: /^3801 — DETROIT/ }).click();
  await page.getByLabel("Estimated crossing").fill(localDateTime(2));
  await page.getByRole("button", { name: "Save trip" }).click();
  await expect(page.getByText(/DETROIT · ETA/)).toBeVisible();
  await page.getByRole("button", { name: /^Truck/ }).click();
  await page.getByLabel("Truck", { exact: true }).selectOption({ label: "T-101 · AB12345" });
  await page.getByRole("button", { name: /^Crew/ }).click();
  await selectByText(page.getByLabel("Add to crew", { exact: true }), "Singh, Gurpreet");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /^Trailers/ }).click();
  await page
    .getByLabel("Hitch trailer", { exact: true })
    .selectOption({ label: "TR-501 · Trailer, dry freight" });
  await page.getByRole("button", { name: "Hitch", exact: true }).click();
  const reference = `PAPS${Date.now().toString(36).toUpperCase()}`;
  await page.getByRole("button", { name: /^Shipments/ }).click();
  await page.getByRole("button", { name: "Add shipment", exact: true }).click();
  const shipment = page.getByRole("form", { name: "New shipment" });
  await shipment.getByLabel("Control reference").fill(reference);
  await shipment.getByLabel("Shipper").selectOption({ label: "Maple Ridge Steel Ltd" });
  await shipment.getByLabel("Consignee").selectOption({ label: "Great Lakes Fabrication Inc" });
  await shipment.getByRole("button", { name: "Save shipment" }).click();
  await page.getByRole("button", { name: `PFTR${reference}` }).click();
  await page.getByRole("button", { name: "+ Add commodity line" }).click();
  const line = page.getByRole("form", { name: "New commodity line" });
  await line.getByLabel("Commodity description").fill("Steel coils");
  await line.getByLabel("Weight", { exact: true }).fill("1000");
  await line.getByLabel("Quantity", { exact: true }).fill("1");
  await line.getByLabel("Quantity unit").selectOption("Coil");
  await line.getByRole("button", { name: "Save line" }).click();
  await expect(page.getByText("Steel coils")).toBeVisible();
  await page.getByRole("button", { name: /^Seals/ }).click();
  await page.getByLabel("Seal number").fill("SL-INT-1");
  await page.getByRole("button", { name: "Add seal" }).click();
  await page.getByRole("button", { name: /^Review/ }).click();
  await expect(page.getByRole("button", { name: "Transmit to CBP" })).toBeEnabled();
}

test.describe("customs gateway integration", () => {
  test("transmit → mock CBP acknowledges, then accepts and releases asynchronously", async ({
    page,
  }) => {
    await login(page, "dispatch@pathfinder.demo");
    await buildReady(page, "TRIP-OK-1");
    await page.getByRole("button", { name: "Transmit to CBP" }).click();

    await expect(heading(page).getByText("sent")).toBeVisible();
    await expect(page.getByText("Awaiting CBP decision")).toBeVisible();
    await expect(page.getByText(/ref ACE-[0-9A-Z]{7}/)).toBeVisible(); // gateway reference
    await expect(
      page.getByRole("list", { name: "Transmission log" }).getByText("→ transmit"),
    ).toBeVisible();

    // Decision arrives via the job queue + Realtime (seeded delay 3s, then release 3s later)
    await expect(heading(page).getByText("accepted")).toBeVisible({ timeout: 20_000 });
    await expect(timeline(page).getByText(/Manifest accepted by ACE/)).toBeVisible();
    await expect(heading(page).getByText("released")).toBeVisible({ timeout: 20_000 });
    await expect(timeline(page).getByText(/Released at primary/)).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Transmission log" }).getByText("← decision").first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark arrived" })).toBeVisible();
  });

  test("REJECT hook → manifest rejected asynchronously and becomes editable", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await buildReady(page, "TRIP-REJECT-1");
    await page.getByRole("button", { name: "Transmit to CBP" }).click();
    await expect(heading(page).getByText("sent")).toBeVisible();
    await expect(heading(page).getByText("rejected")).toBeVisible({ timeout: 20_000 });
    await expect(timeline(page).getByText(/Manifest rejected/)).toBeVisible();
    await page.getByRole("button", { name: /^Trip/ }).click();
    await expect(page.getByLabel("Trip number")).toBeEnabled();
  });

  test("FAIL hook → transport error, manifest stays draft, failure logged", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await buildReady(page, "TRIP-FAIL-1");
    await page.getByRole("button", { name: "Transmit to CBP" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /gateway/ })).toContainText(
      /gateway unavailable.*not transmitted/i,
    );
    await expect(heading(page).getByText("draft")).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Transmission log" })
        .getByText(/503 · Customs gateway unavailable/),
    ).toBeVisible();
    // still editable — user can retry
    await expect(page.getByRole("button", { name: "Transmit to CBP" })).toBeEnabled();
  });
});

test.describe("integrations settings", () => {
  test("owner sees provider cards, the live log, and can run due jobs", async ({ page }) => {
    await login(page, "owner@pathfinder.demo");
    await page.goto("/settings/integrations");
    await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "CBP ACE (US)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "CBSA ACI (Canada)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Integration log" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Background jobs" })).toBeVisible();
    await page.getByRole("button", { name: "Run due now" }).click();
    await expect(page.getByRole("button", { name: "Run due now" })).toBeEnabled();

    // Save a config change and see it persist
    const card = page.locator("form", { hasText: "CBP ACE (US)" });
    await card.getByLabel("Decision delay (ms)").fill("2500");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(
      page.locator("form", { hasText: "CBP ACE (US)" }).getByLabel("Decision delay (ms)"),
    ).toHaveValue("2500");
    // restore
    await page
      .locator("form", { hasText: "CBP ACE (US)" })
      .getByLabel("Decision delay (ms)")
      .fill("3000");
    await page
      .locator("form", { hasText: "CBP ACE (US)" })
      .getByRole("button", { name: "Save" })
      .click();
  });

  test("gateway credentials go into Vault write-only and can be cleared", async ({ page }) => {
    await login(page, "owner@pathfinder.demo");
    await page.goto("/settings/integrations");
    const card = () => page.locator("form", { hasText: "CBSA ACI (Canada)" });
    await card().getByLabel("API key").fill("e2e-api-key");
    await card().getByLabel("API secret").fill("e2e-api-secret");
    await card().getByRole("button", { name: "Save" }).click();
    await expect(card().getByText("Credentials stored")).toBeVisible();
    // the inputs are wiped on save — nothing is left sitting in the DOM
    await expect(card().getByLabel("API key")).toHaveValue("");

    await page.reload();
    await expect(card().getByText("Credentials stored")).toBeVisible();
    await expect(card().getByLabel("API key")).toHaveValue("");
    // and the server never sends the stored values back
    expect(await page.content()).not.toContain("e2e-api-key");

    await card().getByRole("button", { name: "Clear credentials" }).click();
    await expect(card().getByText("Credentials stored")).toBeHidden();
    await page.reload();
    await expect(card().getByText("Credentials stored")).toBeHidden();
  });

  test("read-only cannot reach integrations", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    await page.goto("/settings/integrations");
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe("BorderConnect filing mode (Task 13)", () => {
  test("no company key warns, setting one on Organization clears it, and the mode persists", async ({
    page,
  }) => {
    await login(page, "owner@pathfinder.demo");
    await page.goto("/settings/integrations");
    const card = () => page.locator("form", { hasText: "CBP ACE (US)" });

    // Selecting BorderConnect hides the gateway inputs and, with no company
    // key on file yet, shows the warning rather than "set ✓".
    await card().getByLabel("Filing mode").selectOption("border_connect");
    await expect(card().getByLabel("Gateway base URL")).toHaveCount(0);
    await expect(card().getByLabel("Decision delay (ms)")).toHaveCount(0);
    await expect(card().getByText(/missing — set it in/)).toBeVisible();
    await expect(card().getByRole("button", { name: "Check inbox" })).toBeVisible();

    // Set the company key on Settings → Organization.
    const companyKey = `E2E-BC-${Date.now()}`;
    await page.goto("/settings/organization");
    await page.getByLabel("BorderConnect company key").fill(companyKey);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // Back on Integrations, the warning is gone and the status reads "set".
    await page.goto("/settings/integrations");
    await card().getByLabel("Filing mode").selectOption("border_connect");
    await expect(card().getByText("set ✓")).toBeVisible();
    await expect(card().getByText(/missing — set it in/)).toHaveCount(0);

    // Saving persists the mode.
    await card().getByRole("button", { name: "Save" }).click();
    await expect(card().getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(card().getByLabel("Filing mode")).toHaveValue("border_connect");

    // The internal monitor remains available, but BorderConnect QP messaging
    // fails closed and offers no transport controls.
    await page.goto("/in-bond");
    const inBond = page.getByRole("row", { name: /PFTRPAPS90010/ });
    await expect(
      inBond.getByText("QP In-Bond customs messaging coming soon; tracking only."),
    ).toBeVisible();
    await expect(inBond.getByRole("button", { name: "Send arrival" })).toHaveCount(0);
    await expect(inBond.getByRole("button", { name: "Check status" })).toHaveCount(0);

    // Restore both to their prior state so the seeded fixture and other specs
    // (which expect CBP ACE in mock mode) are unaffected by this run.
    await page.goto("/settings/integrations");
    await card().getByLabel("Filing mode").selectOption("mock");
    await card().getByRole("button", { name: "Save" }).click();
    await expect(card().getByText("Saved.")).toBeVisible();
    await page.goto("/settings/organization");
    await page.getByLabel("BorderConnect company key").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
  });
});

test.describe("billing (mock mode)", () => {
  test("owner upgrades via mock checkout and the plan syncs to the organization", async ({
    page,
  }) => {
    await login(page, "owner@pathfinder.demo");
    await page.goto("/settings/billing");
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("mock mode")).toBeVisible();
    // Idempotent across runs: pick whichever plan is not current.
    const choose = page.getByRole("button", { name: /^Choose / }).first();
    const plan = (await choose.textContent())!.replace("Choose ", "").trim().toLowerCase();
    await Promise.all([page.waitForURL(/checkout=success/), choose.click()]);
    await expect(page.getByText("Subscription updated.")).toBeVisible();
    await expect(page.getByText(new RegExp(`${plan} · active`, "i"))).toBeVisible();
    await expect(page.getByRole("button", { name: "Current plan" })).toBeVisible();
    await page.goto("/dashboard");
    await expect(page.getByText(`${plan} · active`)).toBeVisible();
  });

  test("read-only can view billing but not change plans", async ({ page }) => {
    await login(page, "readonly@pathfinder.demo");
    await page.goto("/settings/billing");
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Choose/ })).toHaveCount(0);
  });
});
