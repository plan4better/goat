import { expect, test } from "@playwright/test";

import { API_URL, actAs, apiAs, needsAuth, userOf } from "../fixtures/users";

/**
 * Organization admins manage every team of their organization (phase 2, B1).
 * The owner creates an empty team the admin is not in; the admin finds it
 * under Teams, opens it, adds editor2, finds no remove action on the team
 * owner's row and removes editor2 again. The owner deletes the team at the end
 * (an empty team can be deleted, unlike the shared one of `ensureSharedTeam`).
 * No organization role changes: specs acting as editor2 in parallel see at
 * most a short team membership.
 *
 * Team names are unique within an organization and other specs keep teams of
 * their own in it, so the name carries the time the file was loaded.
 */
needsAuth(test);
test.describe.configure({ mode: "serial", retries: 0 });

const TEAM_NAME = `E2E admin team ${Date.now().toString(36)}`;
let teamId: string | undefined;

test.beforeAll(async () => {
  const owner = await apiAs("owner");
  try {
    const created = await owner.post(`${API_URL}/api/v2/teams`, { data: { name: TEAM_NAME } });
    expect(created.ok(), await created.text()).toBeTruthy();
    teamId = ((await created.json()) as { id: string }).id;
  } finally {
    await owner.dispose();
  }
});

test.afterAll(async () => {
  if (!teamId) return;
  const owner = await apiAs("owner");
  try {
    const removed = await owner.delete(`${API_URL}/api/v2/teams/${teamId}`);
    expect(removed.ok(), await removed.text()).toBeTruthy();
  } finally {
    await owner.dispose();
  }
});

test.describe("admin", () => {
  actAs(test, "admin");

  test("finds a team they are not in, adds and removes a member, never the owner", async ({ page }) => {
    await page.goto("/settings/teams");
    // The admin's subtitle: the page lists every team of the organization.
    await expect(page.getByText(/^All teams of the organization\./)).toBeVisible();
    await page.getByRole("link", { name: `Open team ${TEAM_NAME}`, exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: TEAM_NAME, exact: true })).toBeVisible();
    // Shown only to an organization owner or admin who is not in the team.
    await expect(page.getByText("You manage the team as an admin")).toBeVisible();

    // As the team page names a person (`personName`): provisioning gives every user both names.
    const editor2 = userOf("editor2");
    const editor2Name = `${editor2.firstname} ${editor2.lastname}`;
    await page.getByRole("button", { name: "Add members" }).click();
    const picker = page.getByRole("dialog").filter({ hasText: "Add members" });
    await picker.getByRole("checkbox", { name: editor2Name, exact: true }).click();
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(`${editor2Name} is now in the team.`)).toBeVisible();

    const members = page.getByRole("region", { name: /^Members/ });
    // The team's owner (the organization's owner) has no row actions for the admin.
    const ownerRow = members.getByRole("listitem").filter({ hasText: "Owner in the organization" });
    await expect(ownerRow).toHaveCount(1);
    await expect(ownerRow.getByRole("button", { name: /More actions/ })).toHaveCount(0);

    await members.getByRole("button", { name: `More actions for ${editor2Name}` }).click();
    await page.getByRole("menuitem", { name: "Remove from the team" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Remove from the team" });
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText(`${editor2Name} is no longer in the team.`)).toBeVisible();
    await expect(members.getByRole("listitem").filter({ hasText: editor2Name })).toHaveCount(0);
  });
});
