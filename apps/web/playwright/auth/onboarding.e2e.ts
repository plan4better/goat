import { expect, test } from "@playwright/test";

import { API_URL, PASSWORD, apiAs, logIn, needsAuth, userOf } from "../fixtures/users";

/**
 * A new user's first login: with no organization they are sent to create
 * one, and they land on Home as its owner.
 *
 * The newcomer is provisioned in Keycloak only. Creating the organization is
 * one-way, so a retry would find them already onboarded: retries are off.
 */
needsAuth(test);
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ retries: 0 });

/** Opens a dropdown by its label and picks an option. */
const choose = async (page: import("@playwright/test").Page, label: RegExp, option: string) => {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

test("a user without an organization creates one on first login", async ({ page }) => {
  await logIn(page, userOf("newcomer").email, PASSWORD);
  await page.waitForURL(/\/onboarding\/organization\/create/, { timeout: 30000 });

  // One step: the name and the type. Everything else about the organization lives in the CRM.
  await page.getByLabel("Your organization's name").fill("Newcomer Planning");
  await choose(page, /Organization type/, "Public sector");
  await page.getByRole("button", { name: "Let's get started" }).click();

  await page.waitForURL(/\/home/, { timeout: 30000 });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(userOf("newcomer").firstname);

  // They own the new organization: it shows up as theirs.
  const newcomer = await apiAs("newcomer");
  try {
    const organization = await newcomer.get(`${API_URL}/api/v2/users/organization`);
    expect(organization.status()).toBe(200);
    expect((await organization.json()).name).toBe("Newcomer Planning");
  } finally {
    await newcomer.dispose();
  }
});
