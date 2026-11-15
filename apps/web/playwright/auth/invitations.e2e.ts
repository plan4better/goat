import { expect, test } from "@playwright/test";

import {
  API_URL,
  PASSWORD,
  apiAs,
  castOf,
  logIn,
  needsAuth,
  storageStatePath,
  userOf,
} from "../fixtures/users";

/**
 * Inviting someone into the organization, end to end: the owner invites from
 * the members page, the invitee is taken to the invitation on first login,
 * nobody else can use it, and accepting makes them a member with the role
 * they were invited with. A fresh invitation cannot be resent until 10 minutes
 * after its send.
 *
 * The invitee is provisioned in Keycloak without an organization. Accepting
 * is one-way, so a retry would find them already a member: retries are off.
 */
needsAuth(test);
test.describe.configure({ mode: "serial", retries: 0 });

let invitationPath: string;

test("the owner invites a user as a viewer from the members page", async ({ page }) => {
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Invite members" }).click();

  // The field makes a chip of each address, trimmed and lowercased as core
  // stores it, so the row names it lowercased.
  const email = userOf("invitee").email.toLowerCase();
  const dialog = page.getByRole("dialog").filter({ hasText: "Invite members" });
  const addresses = dialog.getByLabel("Email addresses");
  await addresses.fill(userOf("invitee").email);
  await addresses.press("Enter");
  await dialog.getByRole("radio", { name: /^Viewer/ }).click();
  await dialog.getByRole("button", { name: "Send invitation" }).click();

  // No toast: the dialog closes and the invitation is in the list.
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("Invitation pending");
});

// A successful resend is covered by core's tests (tests/api/test_invitation_resend.py),
// not here: it would mail the invitee again.
test("the new invitation cannot be resent yet, and says from when", async ({ page }) => {
  const email = userOf("invitee").email.toLowerCase();
  await page.goto("/settings/members");
  const row = page.getByRole("row").filter({ hasText: email });
  await row.getByRole("button", { name: `More actions for ${email}` }).click();
  // Disabled for 10 minutes after the last send, with the time under its label.
  const resend = page.getByRole("menuitem", { name: /^Resend invitation/ });
  await expect(resend).toHaveAttribute("aria-disabled", "true");
  await expect(resend).toContainText(/Resending possible from \d{2}:\d{2}\./);
  await page.keyboard.press("Escape");
});

test.describe("the invitee", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("is taken to the invitation on first login, which nobody else can use", async ({ page, browser }) => {
    await logIn(page, userOf("invitee").email, PASSWORD);
    await page.waitForURL(/\/onboarding\/organization\/invite\//, { timeout: 30000 });
    await expect(
      page.getByRole("heading", {
        name: "You have been invited to join the organization: E2E Organization",
        exact: true,
      })
    ).toBeVisible();
    invitationPath = new URL(page.url()).pathname;

    // A user from another organization opening the same link is turned away.
    const outsider = await browser.newContext({ storageState: storageStatePath("outsider") });
    try {
      const outsiderPage = await outsider.newPage();
      await outsiderPage.goto(invitationPath);
      await expect(outsiderPage.getByRole("heading", { name: "We are sorry" })).toBeVisible({
        timeout: 30000,
      });
      await expect(outsiderPage.getByRole("button", { name: "Accept" })).toHaveCount(0);
    } finally {
      await outsider.close();
    }

    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForURL(/\/home/, { timeout: 30000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(userOf("invitee").firstname);
  });
});

test("the invitee is now a viewer of the owner's organization", async () => {
  const invitee = await apiAs("invitee");
  try {
    const organization = await invitee.get(`${API_URL}/api/v2/users/organization`);
    expect(organization.status()).toBe(200);
    expect((await organization.json()).id).toBe(castOf().organization_id);

    const profile = await invitee.get(`${API_URL}/api/v2/users/profile`);
    expect((await profile.json()).roles).toContain("organization-viewer");
  } finally {
    await invitee.dispose();
  }
});
