import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Phase 5 — Risk/Alerts: anomaly scoring + hold-prediction wired into cargo
 * save, and the notifications system (bell, list, per-event rules) driven by
 * a critical alert. Requires local Supabase + `pnpm db:seed`.
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("corridor-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

const localDateTime = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Idempotent toggle: sets the checkbox to `desired`, tolerating leftover state from earlier runs. */
async function setChecked(checkbox: Locator, desired: boolean) {
  if ((await checkbox.isChecked()) !== desired) {
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: desired });
  }
}

test.describe("risk detection", () => {
  test("a wildly outlying shipment line raises a risk_flag alert on the movement", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/movements");
    await page.getByRole("button", { name: "New ACE movement" }).click();
    await expect(page).toHaveURL(/\/movements\/[0-9a-f-]{36}/);
    const url = page.url();
    const movementId = url.split("/movements/")[1]!;

    await page.getByLabel("Trip number").fill("RISK-TRIP");
    await page.getByLabel("Port of entry").selectOption({ label: "3801 · Detroit — Ambassador Bridge, MI" });
    await page.getByLabel("Estimated crossing").fill(localDateTime(2));
    await page.getByRole("button", { name: "Save trip" }).click();

    await page.getByRole("button", { name: /^Shipment/ }).click();
    await page.getByRole("button", { name: "Add shipment line" }).click();
    const form = page.getByRole("form", { name: "New shipment line" });
    await form.getByLabel("Commodity description").fill("Hot-rolled steel coils");
    await form.getByLabel("Shipper").selectOption({ label: "Maple Ridge Steel Ltd" });
    await form.getByLabel("Consignee").selectOption({ label: "Great Lakes Fabrication Inc" });
    await form.getByLabel("HS code").fill("7208.10");
    // Within the 100,000kg schema max, but far above the seeded lane average (~17-22k).
    await form.getByLabel("Weight (kg)").fill("99000");
    await form.getByLabel("Pieces").fill("12");
    await form.getByRole("button", { name: "Save line" }).click();
    await expect(page.getByRole("cell", { name: "Hot-rolled steel coils" })).toBeVisible();

    // Risk findings land as compliance alerts (a separate concern from the
    // pre-transmit validation checklist on the Review step), linked to this movement.
    await page.goto("/alerts");
    const alertRow = page
      .locator("div.panel > div", { hasText: /weight is .*% above this lane's average/ })
      .filter({ has: page.locator(`a[href="/movements/${movementId}"]`) });
    await expect(alertRow).toBeVisible();

    // Correcting the value back in range resolves the alert automatically.
    await page.goto(url);
    await page.getByRole("button", { name: /^Shipment/ }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    const editForm = page.getByRole("form", { name: "Edit shipment line" });
    await editForm.getByLabel("Weight (kg)").fill("21000");
    await editForm.getByRole("button", { name: "Save line" }).click();

    await page.goto("/alerts");
    await expect(
      page.locator("div.panel > div").filter({ has: page.locator(`a[href="/movements/${movementId}"]`) }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Resolved" }).click();
    await expect(
      page
        .locator("div.panel > div", { hasText: /weight is .*% above this lane's average/ })
        .filter({ has: page.locator(`a[href="/movements/${movementId}"]`) }),
    ).toBeVisible();
  });
});

test.describe("notifications", () => {
  test("a critical alert notifies the bell and can be marked read from the notifications page", async ({ page }) => {
    await login(page, "owner@pathfinder.demo");
    await page.goto("/parties/trucks");
    const unit = `T-NOTIF-${Date.now().toString(36).toUpperCase()}`;
    await page.getByRole("button", { name: "New truck" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Unit number").fill(unit);
    await dialog.locator("#trucks-plateNumber").fill("NOTIF1");
    await dialog.getByLabel("Plate province/state").fill("ON");
    // Expired insurance = critical document_expiry finding = a notification.
    const expired = new Date();
    expired.setDate(expired.getDate() - 5);
    await dialog.getByLabel("Insurance expiry").fill(expired.toISOString().slice(0, 10));
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);

    const bell = page.getByRole("button", { name: /Notifications/ });
    await expect(bell).toBeVisible();
    // The insert lands via Realtime/polling within a few seconds.
    await expect
      .poll(async () => (await bell.getAttribute("aria-label")) ?? "", { timeout: 15_000 })
      .toMatch(/\d+ unread/);
    await bell.click();
    await expect(page.getByText(new RegExp(`Insurance expired.*${unit}`))).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/notifications");
    const row = page.locator(".panel > div", { hasText: unit });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Mark read" }).click();
    await expect(row.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  });

  test("opting out of an event type stops future notifications for that user", async ({ page }) => {
    await login(page, "dispatch@pathfinder.demo");
    await page.goto("/settings/notifications");
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    const row = page.locator("div.flex.flex-wrap.items-center.justify-between", { hasText: "Critical compliance alert" });
    await setChecked(row.getByLabel("Notify me"), false);
    await expect(row.getByLabel("Email")).toBeDisabled();

    await page.goto("/parties/trucks");
    const unit = `T-OPTOUT-${Date.now().toString(36).toUpperCase()}`;
    await page.getByRole("button", { name: "New truck" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Unit number").fill(unit);
    await dialog.locator("#trucks-plateNumber").fill("OPTOUT1");
    await dialog.getByLabel("Plate province/state").fill("ON");
    const expired = new Date();
    expired.setDate(expired.getDate() - 3);
    await dialog.getByLabel("Insurance expiry").fill(expired.toISOString().slice(0, 10));
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    // Give the afterSave alert sync + notify_organization fan-out time to run.
    await page.waitForTimeout(1500);

    // Check for the absence of a notification mentioning this specific truck —
    // robust regardless of how many unrelated unread notifications already
    // exist from other tests sharing this seeded user.
    await page.goto("/notifications");
    await expect(page.getByText(new RegExp(unit))).toHaveCount(0);

    // restore for other test runs sharing this seeded user
    await page.goto("/settings/notifications");
    await setChecked(row.getByLabel("Notify me"), true);
  });
});
