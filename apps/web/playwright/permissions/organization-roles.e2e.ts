import { type Page, expect, test } from "@playwright/test";

import { API_URL, type Role, actAs, apiAs, castOf, needsAuth } from "../fixtures/users";

/**
 * What each organization role may do with the organization itself.
 *
 * Owners and admins manage the organization: in Settings they see Profile,
 * Members, Teams and White Label with the pages under it, Domains and
 * Analytics (and Usage where billing runs; the e2e stack runs without it, so
 * the Usage page is not there). Editors and viewers see Profile and Teams and
 * the organization read-only, and the API refuses them the organization's
 * management routes even when called directly. Only the owner deletes the
 * organization. Viewers cannot create teams, and only owners and admins list
 * every team of the organization; everyone else lists their own.
 */
needsAuth(test);

const ORGANIZATION_ADMIN_LINKS = ["Members", "Domains", "Analytics"];

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings", exact: true });

for (const role of ["owner", "admin"] as Role[]) {
  test.describe(`${role}`, () => {
    actAs(test, role);

    test("sees the organization's settings, White Label with Domains and Analytics", async ({ page }) => {
      await page.goto("/settings/profile");
      const organization = settingsNav(page).getByRole("group", { name: "Organization" });
      for (const name of ["Profile", "Teams", ...ORGANIZATION_ADMIN_LINKS]) {
        await expect(organization.getByRole("link", { name, exact: true })).toBeVisible();
      }
      await expect(organization.getByRole("button", { name: "White Label" })).toBeVisible();
    });
  });
}

test.describe("admin, unlike the owner", () => {
  actAs(test, "admin");

  test("sees Delete organization disabled, for the owner only", async ({ page }) => {
    await page.goto("/settings/organization");
    await expect(page.getByRole("button", { name: "Delete organization" })).toBeDisabled();
    await expect(page.getByText("Only the owner can delete the organization.")).toBeVisible();
  });

  test("is refused the organization delete by the API (F1)", async () => {
    const api = await apiAs("admin");
    try {
      const remove = await api.delete(`${API_URL}/api/v2/organizations/${castOf().organization_id}`);
      expect([401, 403]).toContain(remove.status());
    } finally {
      await api.dispose();
    }
  });
});

for (const role of ["editor", "viewer"] as Role[]) {
  test.describe(`${role}`, () => {
    actAs(test, role);

    test("sees only the profiles and teams in Settings", async ({ page }) => {
      await page.goto("/settings/profile");
      const nav = settingsNav(page);
      const organization = nav.getByRole("group", { name: "Organization" });
      for (const name of ["Profile", "Teams"]) {
        await expect(organization.getByRole("link", { name, exact: true })).toBeVisible();
      }
      // Until the roles are known, the rows only owners and admins get are
      // skeletons without a link or a button, so the checks below would pass
      // before the roles arrive: wait for the nav to settle first.
      await expect(nav.locator(".MuiSkeleton-root")).toHaveCount(0);
      for (const name of ORGANIZATION_ADMIN_LINKS) {
        await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
      }
      await expect(nav.getByRole("button", { name: "White Label" })).toHaveCount(0);
    });

    test("sees the organization read-only", async ({ page }) => {
      await page.goto("/settings/organization");
      await expect(page.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
      // The members' subtitle: the roles are known, so the cards below are final.
      await expect(
        page.getByText("Your organization in GOAT. Owners and admins can change it.")
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete organization" })).toHaveCount(0);
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

test.describe("viewer, by the API", () => {
  test("is refused creating a team (decision 5)", async () => {
    const api = await apiAs("viewer");
    try {
      // Unique: team names are unique within the organization, and a wrong 2xx
      // would leave the team behind.
      const created = await api.post(`${API_URL}/api/v2/teams`, {
        data: { name: `E2E team by a viewer ${Date.now().toString(36)}` },
      });
      expect([401, 403]).toContain(created.status());
    } finally {
      await api.dispose();
    }
  });
});

test.describe("editor, by the API", () => {
  test("is refused the list of every team, but keeps their own (B1)", async () => {
    const api = await apiAs("editor");
    try {
      const all = await api.get(`${API_URL}/api/v2/teams`, { params: { scope: "organization" } });
      expect([401, 403]).toContain(all.status());
      const own = await api.get(`${API_URL}/api/v2/teams`);
      expect(own.status()).toBe(200);
    } finally {
      await api.dispose();
    }
  });
});

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
