import { type Page, expect, test } from "@playwright/test";

/**
 * Settings loads without redirect pages and draws its nav at once (Settings
 * load, L1 and L2). Runs as the owner (auth off: the default user).
 */

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings", exact: true });

/** The paths of the documents the page renders (status 200) from now on. */
const renderedDocuments = (page: Page): string[] => {
  const paths: string[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "document" && response.status() === 200) {
      paths.push(new URL(response.url()).pathname);
    }
  });
  return paths;
};

/** The paths the page loads in full from now on, whatever the answer: the
 * main frame's navigations only, as Home's announcements may load iframes. */
const documentRequests = (page: Page): string[] => {
  const paths: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      paths.push(new URL(request.url()).pathname);
    }
  });
  return paths;
};

/** The paths of the RSC requests the page makes from now on to navigate:
 * prefetches, which carry `next-router-prefetch`, are left out. */
const navigationRequests = (page: Page): string[] => {
  const paths: string[] = [];
  page.on("request", (request) => {
    const headers = request.headers();
    if (headers["rsc"] === "1" && !headers["next-router-prefetch"]) {
      paths.push(new URL(request.url()).pathname);
    }
  });
  return paths;
};

test("a typed /settings is one 307 to the profile, then one document", async ({ page, request }) => {
  const answer = await request.get("/settings", { maxRedirects: 0 });
  expect(answer.status()).toBe(307);
  expect(new URL(answer.headers()["location"], "http://goat.test").pathname).toBe("/settings/profile");

  // Only the profile is a rendered document: no redirect page that loads the app and moves on.
  const rendered = renderedDocuments(page);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(page.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
  expect(rendered).toEqual(["/settings/profile"]);
});

test("the sidebar's Settings link costs one RSC request, to the profile itself", async ({ page }) => {
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: /Welcome/ })).toBeVisible();
  // The sidebar has no landmark of its own: it is the list of the app's sections.
  const sidebar = page
    .getByRole("list")
    .filter({ has: page.getByRole("link", { name: "Catalog", exact: true }) });
  const settings = sidebar.getByRole("link", { name: "Settings", exact: true });
  await expect(settings).toHaveAttribute("href", "/settings/profile");

  const documents = documentRequests(page);
  const rsc = navigationRequests(page);
  await settings.click();
  await expect(page.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
  // A client navigation: no page load, which would need no RSC request at all.
  expect(documents).toEqual([]);
  // At most one, as a production build may have prefetched the page already.
  expect(rsc.length).toBeLessThanOrEqual(1);
  expect(rsc.filter((path) => path !== "/settings/profile")).toEqual([]);
});

test("draws the nav before the profile answers", async ({ page }) => {
  let asked = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/v2\/users\/profile$/, async (route) => {
    asked = true;
    await held;
    await route.continue();
  });

  await page.goto("/settings/members", { waitUntil: "commit" });
  // The page has hydrated and asked for the profile, which is held back: the
  // nav checked from here on is the client's, not only the server's HTML.
  await expect.poll(() => asked).toBe(true);
  const nav = settingsNav(page);
  await expect(nav.getByRole("link", { name: "Language and appearance" })).toBeVisible();
  const organization = nav.getByRole("group", { name: "Organization" });
  await expect(organization.getByRole("link", { name: "Teams", exact: true })).toBeVisible();
  // Members waits for the roles: a placeholder until the profile answers.
  await expect(organization.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);

  release();
  await expect(organization.getByRole("link", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Members" })).toBeVisible();
});
