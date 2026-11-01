import { expect, test } from "@playwright/test";

import { API_URL, type Role, actAs, apiAs, castOf, needsAuth } from "../fixtures/users";

/**
 * What each organization role may do with the organization itself.
 *
 * Owners and admins manage the organization: its profile, members and white
 * label (and its usage where billing runs; the e2e stack runs without it, so
 * the Usage page is not there). Editors and viewers see only their account and
 * teams in Settings, and the API refuses them the organization's management
 * routes even when called directly.
 */
needsAuth(test);

const ADMIN_ONLY = ["Organization", "White Label"];

for (const role of ["owner", "admin"] as Role[]) {
  test.describe(`${role}`, () => {
    actAs(test, role);

    test("sees the organization's settings", async ({ page }) => {
      await page.goto("/settings/account");
      for (const name of ["Account", "Teams", ...ADMIN_ONLY]) {
        await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
      }
    });
  });
}

for (const role of ["editor", "viewer"] as Role[]) {
  test.describe(`${role}`, () => {
    actAs(test, role);

    test("sees only their account and teams in Settings", async ({ page }) => {
      await page.goto("/settings/account");
      for (const name of ["Account", "Teams"]) {
        await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
      }
      for (const name of ADMIN_ONLY) {
        await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
      }
    });

    test("is refused the organization's management routes", async () => {
      const api = await apiAs(role);
      const organizationId = castOf().organization_id;
      try {
        const invite = await api.post(`${API_URL}/api/v2/organizations/${organizationId}/invitations`, {
          data: { user_email: `e2e-nobody-${role}@goat.test`, role: "organization-viewer" },
        });
        expect([401, 403]).toContain(invite.status());

        const rename = await api.patch(`${API_URL}/api/v2/organizations/${organizationId}/profile`, {
          data: { name: "Renamed by a member" },
        });
        expect([401, 403]).toContain(rename.status());

        const remove = await api.delete(`${API_URL}/api/v2/organizations/${organizationId}`);
        expect([401, 403]).toContain(remove.status());
      } finally {
        await api.dispose();
      }
    });
  });
}

test("the organization still exists, unrenamed, afterwards", async () => {
  const owner = await apiAs("owner");
  try {
    const organization = await owner.get(`${API_URL}/api/v2/users/organization`);
    expect(organization.status()).toBe(200);
    expect((await organization.json()).name).toBe("E2E Organization");
  } finally {
    await owner.dispose();
  }
});
