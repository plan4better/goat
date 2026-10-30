import { expect, test as setup } from "@playwright/test";

import { AUTH_ON, PASSWORD, SESSION_ROLES, logIn, storageStatePath, userOf } from "./fixtures/users";

/**
 * Logs each provisioned role in through the real login page once and saves
 * the browser session, which the specs then start from (`actAs`). Runs before
 * the specs as the "setup" project; with auth off there is nothing to log
 * into and it does nothing.
 */

for (const role of SESSION_ROLES) {
  setup(`log in as ${role}`, async ({ page }) => {
    setup.skip(!AUTH_ON, "auth is off");
    // Home may open its Welcome or release spotlight (the release feed is
    // live outside CI); skipping it also records it as seen for the specs.
    await page.addLocatorHandler(
      page.getByRole("button", { name: /^(skip|skip guide|überspringen|guide überspringen)$/i }),
      async (skip) => {
        await skip.click();
      },
    );
    await logIn(page, userOf(role).email, PASSWORD);
    // Home greets the signed-in user by first name.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(userOf(role).firstname, {
      timeout: 30000,
    });
    await page.context().storageState({ path: storageStatePath(role) });
  });
}
