import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { statusInk } from "@/components/common/StatusPill";
import StatusChip from "@/components/support/StatusChip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, o?: { name?: string }) => (o?.name ? `${key}:${o.name}` : key) }),
}));

describe("StatusChip", () => {
  it("says 'needs your reply' when it waits for me", () => {
    render(<StatusChip ticket={{ status: "waiting", needs_my_reply: true, customer_name: "Anna" }} />);
    expect(screen.getByText("support_status_waiting")).toBeTruthy();
  });
  it("names the person an admin's colleague ticket waits for", () => {
    render(
      <StatusChip ticket={{ status: "waiting", needs_my_reply: false, customer_name: "Anna Keller" }} />
    );
    expect(screen.getByText("support_status_waiting_for:Anna Keller")).toBeTruthy();
  });
  it("is GOAT's status pill, its ink readable on the tint", () => {
    const theme = createAppTheme({ mode: "light", locale: "en" });
    render(
      <ThemeProvider theme={theme}>
        <StatusChip ticket={{ status: "waiting", needs_my_reply: true, customer_name: "Anna" }} />
      </ThemeProvider>
    );
    expect(screen.getByText("support_status_waiting").parentElement).toHaveStyle({
      color: statusInk(theme, "warning"),
    });
  });
  it("labels other statuses", () => {
    render(<StatusChip ticket={{ status: "solved", needs_my_reply: false, customer_name: null }} />);
    expect(screen.getByText("support_status_solved")).toBeTruthy();
  });
});
