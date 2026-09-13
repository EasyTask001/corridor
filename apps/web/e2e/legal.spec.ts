import { expect, test } from "@playwright/test";

test.describe("legal pages", () => {
  test("every legal page renders signed-out, with cross-page nav", async ({ page }) => {
    for (const [slug, title] of [
      ["terms", "Terms of Service"],
      ["privacy", "Privacy Policy"],
      ["data-retention", "Data Retention & Deletion"],
      ["ai-disclaimer", "AI Disclaimer"],
      ["security", "Vulnerability Disclosure Policy"],
    ] as const) {
      await page.goto(`/legal/${slug}`);
      await expect(page).toHaveURL(new RegExp(`/legal/${slug}$`));
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation").getByRole("link", { name: "Privacy Policy" })).toBeVisible();
    }
  });

  test("/legal redirects to /legal/terms", async ({ page }) => {
    await page.goto("/legal");
    await expect(page).toHaveURL(/\/legal\/terms$/);
  });

  test("/.well-known/security.txt is served as plain text", async ({ request }) => {
    const res = await request.get("/.well-known/security.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Contact: mailto:");
    expect(body).toContain("Policy:");
  });

  test("the login screen footer links to Terms and Privacy", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Terms" }).first()).toHaveAttribute(
      "href",
      "/legal/terms",
    );
    await expect(page.getByRole("link", { name: "Privacy" }).first()).toHaveAttribute(
      "href",
      "/legal/privacy",
    );
  });

  test("the signup form shows a Terms/Privacy consent line", async ({ page }) => {
    await page.goto("/signup");
    const consent = page.getByText("By creating an account you agree to the");
    await expect(consent).toBeVisible();
    await expect(consent.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/legal/terms",
    );
    await expect(consent.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/legal/privacy",
    );
  });
});
