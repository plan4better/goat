import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Every grid tile the Content page renders (folder, project, dataset) carries
 * this class, regardless of MUI's own internals — see `ContentCard.tsx` /
 * `ContentFolderCard.tsx`. It is the stable hook for locating one by name,
 * rather than matching on MUI's generated class names.
 */
const CONTENT_CARD_SELECTOR = ".content-card";

/**
 * Finds an item's grid tile at the default space's root, reloading between
 * attempts.
 *
 * The feed is fetched once per page load and does not poll, so waiting on the
 * DOM alone only ever sees the listing as it was when the page opened. An
 * upload's metadata row lands a moment after the dialog closes (the dialog
 * does not wait for it), which is exactly the case a single wait misses.
 * Returns `null` once the attempts are used up.
 */
export const locateContentCard = async (page: Page, name: string, attempts = 4): Promise<Locator | null> => {
  await page.goto("/content");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await page.reload();
    const card = page.locator(CONTENT_CARD_SELECTOR).filter({ hasText: name }).first();
    const appeared = await card
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) return card;
  }
  return null;
};

const deleteLocatedCard = async (page: Page, card: Locator): Promise<void> => {
  await card.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Delete" }).click();

  const deleteDialog = page.getByRole("dialog").filter({ hasText: "Delete 1 items" });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete" }).click();
  await expect(deleteDialog).toBeHidden({ timeout: 10000 });
};

/**
 * Deletes a Content page item (folder, project or dataset) by its visible
 * name, from whichever space is currently the default (My Content, once
 * navigated to `/content` fresh). Deleting moves the item to the space's
 * trash — the Content page has no separate "purge" affordance — which is
 * enough to get it out of the way of later test runs.
 *
 * Used by specs to clean up the artefacts they create.
 */
export const deleteContentItem = async (page: Page, name: string): Promise<void> => {
  const card = await locateContentCard(page, name);
  expect(card, `no content item named "${name}" to delete`).not.toBeNull();
  await deleteLocatedCard(page, card as Locator);
};

/**
 * Best-effort version of `deleteContentItem`, for artefacts whose creation
 * this environment cannot fully guarantee (e.g. an upload whose processing
 * job never runs because geoapi/processes are not up). Never fails the test —
 * a dataset that never made it into the list leaves nothing to clean up.
 */
export const tryDeleteContentItem = async (page: Page, name: string): Promise<void> => {
  const card = await locateContentCard(page, name);
  if (!card) return;
  await deleteLocatedCard(page, card);
};

/**
 * The team space specs share whenever they need a team to grant something to.
 *
 * Specs must not create a team per run: `DELETE /teams/{id}` refuses while
 * the team's space still owns content — trashed content included — and
 * nothing can empty a space's trash, so every team a spec created would
 * survive its own cleanup and pile up in the database. One long-lived team,
 * created only where it does not exist yet and never deleted, keeps the
 * suite's footprint flat.
 */
export const SHARED_TEAM_NAME = "Design QA";

/**
 * Leaves `SHARED_TEAM_NAME` existing, creating it only on an environment
 * that has never had it. Never deletes it.
 */
export const ensureSharedTeam = async (page: Page): Promise<void> => {
  // "No such team" and "the teams have not arrived yet" both lack the card —
  // wait for the request itself, then for its cards to be drawn (the loading
  // placeholder gone) before reading the list, or a second team gets created.
  const teamsLoaded = page.waitForResponse(
    (response) => /\/api\/v2\/teams(\?|$)/.test(response.url()) && response.ok()
  );
  await page.goto("/settings/teams");
  await teamsLoaded;
  await expect(page.getByRole("status", { name: "Loading" })).toHaveCount(0);

  const row = page.getByText(SHARED_TEAM_NAME, { exact: true });
  if ((await row.count()) > 0) return;

  // `first()`: a member without teams sees "New team" twice, in the header
  // and in the empty state.
  await page.getByRole("button", { name: "New team" }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "New team" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Team name").fill(SHARED_TEAM_NAME);
  await dialog.getByRole("button", { name: "Create team", exact: true }).click();
  await expect(dialog).toBeHidden();
  // Creating opens the new team's page, which names it in its heading.
  await expect(row.first()).toBeVisible({ timeout: 15000 });
};
