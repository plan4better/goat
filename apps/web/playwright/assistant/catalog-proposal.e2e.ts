import { type APIRequestContext, expect, test } from "@playwright/test";

// The assistant's end-to-end test (spec §12): dock, a catalog proposal, Apply.
// It needs the assistant on the fake model, so run it through
// apps/assistant/e2e/run.sh, which starts this checkout with goat-slot and the
// fake model (apps/assistant/e2e/fake_openai.py). No provider key is involved.
// The fake calls catalog_propose_filters with q "Radverkehr" and the theme
// "transportation", then answers with a fixed sentence.
// run.sh sets E2E_ASSISTANT; elsewhere (the E2E workflow starts no assistant,
// so no page offers "Ask AI") the spec is skipped.
test.skip(
  !process.env.E2E_ASSISTANT,
  "needs the assistant on the fake model: E2E_ASSISTANT (apps/assistant/e2e/run.sh)"
);

test.describe("Assistant", () => {
  // The conversation the test creates, removed again so repeated runs leave no history.
  let created: { url: string; headers: Record<string, string> } | undefined;

  test.afterEach(async ({ request }: { request: APIRequestContext }) => {
    if (!created) return;
    const { url, headers } = created;
    created = undefined;
    await request.delete(url, { headers });
  });

  test("proposes catalog filters and applies them to the page", async ({ page }) => {
    await page.goto("/catalog");

    await page.getByRole("button", { name: "Ask AI" }).first().click();
    await page.getByRole("textbox", { name: "Ask a question" }).fill("Radverkehr");

    // POST /conversations answers the first send; its id is what gets deleted afterwards.
    const conversation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && /\/conversations\/?$/.test(new URL(response.url()).pathname)
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const response = await conversation;
    const { id } = (await response.json()) as { id: string };
    // The bearer token, when the assistant needs one, is the page's own.
    const authorization = Object.entries(response.request().headers()).filter(
      ([name]) => name === "authorization"
    );
    created = {
      url: `${response.url().replace(/\/conversations\/?$/, "")}/conversations/${id}`,
      headers: Object.fromEntries(authorization),
    };

    const apply = page.getByRole("button", { name: "Apply to page" });
    await expect(apply).toBeVisible();
    await expect(page.getByText("I set the catalog to cycling data")).toBeVisible();

    await apply.click();
    await expect(page).toHaveURL(/[?&]q=Radverkehr(&|$)/);
    await expect(page).toHaveURL(/[?&]themes=transportation(&|$)/);
  });
});
