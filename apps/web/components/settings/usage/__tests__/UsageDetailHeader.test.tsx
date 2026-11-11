import { ThemeProvider } from "@mui/material/styles";
import { render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { readableText } from "@/lib/utils/credits";

import { UsageDetailHeader } from "@/components/settings/usage/UsageDetailHeader";

const support = vi.hoisted(() => ({ href: null as string | null }));

vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => support.href }));

const theme = createAppTheme({ mode: "light", locale: "en" });

const SUPPORT_FORM = "/support/new?from=%2Fsettings%2Fusage";
const LIMIT_LINE =
  "When the credits are used up, tools, workflows and layer downloads stop until they reset. Maps and dashboards keep loading.";

const renderHeader = (props: Partial<ComponentProps<typeof UsageDetailHeader>> = {}) =>
  render(
    <ThemeProvider theme={theme}>
      <I18nextProvider i18n={commonI18n("en")}>
        <UsageDetailHeader
          title="Credits"
          amount="2,204"
          amountRest="out of 10,000 this period. Resets on 30 Nov 2026."
          explain="Running tools and workflows uses compute credits."
          limitLine={LIMIT_LINE}
          {...props}
        />
      </I18nextProvider>
    </ThemeProvider>
  );

describe("UsageDetailHeader", () => {
  beforeEach(() => {
    support.href = SUPPORT_FORM;
  });

  it("states the amount and what counts under its title", () => {
    renderHeader();
    expect(screen.getByRole("heading", { level: 3, name: "Credits" })).toBeInTheDocument();
    expect(screen.getByText("2,204").tagName).toBe("STRONG");
    expect(
      screen.getByText("out of 10,000 this period. Resets on 30 Nov 2026.", { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByText("Running tools and workflows uses compute credits.")).toBeInTheDocument();
  });

  it("links Ask for more to the support form", () => {
    renderHeader();
    expect(screen.getByText(LIMIT_LINE, { exact: false })).toBeInTheDocument();
    // DOM properties rather than jest-dom's attribute, state and focus matchers: the
    // repo's ESLint setup reads those as Playwright's (async) matchers.
    expect(screen.getByRole("link", { name: "Ask for more" }).getAttribute("href")).toBe(SUPPORT_FORM);
  });

  it("drops the link where there is no support", () => {
    support.href = null;
    renderHeader();
    expect(screen.getByText(LIMIT_LINE, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ask for more" })).not.toBeInTheDocument();
  });

  it("shows an over-limit callout with the link instead of the line", () => {
    renderHeader({
      amount: "57.8 GB",
      amountRest: "out of 50 GB. Over the limit by 7.8 GB.",
      amountTone: "error",
      limitLine: undefined,
      callout:
        "Storage is over the limit, so new datasets can't be uploaded until it is below the limit again.",
    });
    const callout = screen.getByRole("status");
    expect(callout).toHaveTextContent("Storage is over the limit");
    expect(within(callout).getByRole("link", { name: "Ask for more" }).getAttribute("href")).toBe(
      SUPPORT_FORM
    );
    expect(screen.getAllByRole("link", { name: "Ask for more" })).toHaveLength(1);
    expect(screen.getByText("57.8 GB")).toHaveStyle({ color: readableText(theme, theme.palette.error.main) });
  });

  it("opens a mail to support where there are no tickets", () => {
    support.href = "mailto:support@example.org";
    renderHeader();
    expect(screen.getByRole("link", { name: "Ask for more" }).getAttribute("href")).toBe(
      "mailto:support@example.org"
    );
  });

  it("puts an action beside the title", () => {
    renderHeader({ action: <a href="/settings/members">Manage members</a> });
    expect(screen.getByRole("link", { name: "Manage members" })).toBeInTheDocument();
  });
});
