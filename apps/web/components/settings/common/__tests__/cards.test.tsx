import { ThemeProvider, alpha } from "@mui/material";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";
import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { declaredStyle } from "@/lib/__tests__/declaredStyle";

import CardSkeleton from "@/components/settings/common/CardSkeleton";
import DangerCard from "@/components/settings/common/DangerCard";
import RowMenu from "@/components/settings/common/RowMenu";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";

// jest-dom's `toBeDisabled`, `toHaveAttribute`, `toHaveFocus` and the like are
// awaited (or the state is read off the DOM): the repo's ESLint setup reads
// them as Playwright's async matchers of the same name.
const wrap = (node: ReactNode) => render(<I18nextProvider i18n={commonI18n("de")}>{node}</I18nextProvider>);

describe("SettingsCard", () => {
  it("is a section named by its h3, with the hint, the action and the body", () => {
    wrap(
      <SettingsCard title="Persönliche Angaben" hint="Name und Bild" action={<button>Mehr</button>}>
        <p>body</p>
      </SettingsCard>
    );
    const section = screen.getByRole("region", { name: "Persönliche Angaben" });
    expect(
      within(section).getByRole("heading", { level: 3, name: "Persönliche Angaben" })
    ).toBeInTheDocument();
    expect(within(section).getByText("Name und Bild")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Mehr" })).toBeInTheDocument();
    expect(within(section).getByText("body")).toBeInTheDocument();
  });

  it("puts the action under the title and hint on a phone, as Content's toolbar row does", () => {
    wrap(
      <SettingsCard
        title="Womit der Assistent antwortet"
        hint="Eine Verbindung ist aktiv."
        action={<button>Eigene</button>}>
        <p>body</p>
      </SettingsCard>
    );
    const title = screen.getByRole("heading", { level: 3 }).parentElement as HTMLElement;
    const row = title.parentElement as HTMLElement;
    expect(getComputedStyle(row).flexWrap).toBe("wrap");
    // Below `md` the title and hint take the whole row, so the action wraps
    // under them; from `md` they take the room left of it, at least 220px.
    expect(declaredStyle(title, "flex", "(min-width:0px)")).toBe("1 0 100%");
    expect(declaredStyle(title, "min-width", "(min-width:900px)")).toBe("220px");
  });

  it("tints a danger card: its border and its title in error ink", () => {
    const theme = createAppTheme({ mode: "light", locale: "de" });
    render(
      <ThemeProvider theme={theme}>
        <SettingsCard title="Konto löschen" tone="danger">
          <p>body</p>
        </SettingsCard>
        <SettingsCard title="Persönliche Angaben">
          <p>body</p>
        </SettingsCard>
      </ThemeProvider>
    );
    const danger = screen.getByRole("region", { name: "Konto löschen" });
    expect(within(danger).getByRole("heading", { level: 3 })).toHaveStyle({
      color: theme.palette.error.main,
    });
    expect(declaredStyle(danger, "border-color")).toBe(alpha(theme.palette.error.main, 0.45));
    const plain = screen.getByRole("region", { name: "Persönliche Angaben" });
    expect(within(plain).getByRole("heading", { level: 3 })).toHaveStyle({
      color: theme.palette.text.primary,
    });
    expect(declaredStyle(plain, "border-color")).not.toBe(alpha(theme.palette.error.main, 0.45));
  });

  it("draws the icon before the title and the footer below the body", () => {
    wrap(
      <SettingsCard
        title="So richten Sie es ein"
        icon={ICON_NAME.CIRCLEINFO}
        footer={<div>Speicherleiste</div>}>
        <p>body</p>
      </SettingsCard>
    );
    const section = screen.getByRole("region", { name: "So richten Sie es ein" });
    const heading = within(section).getByRole("heading", { level: 3 });
    expect(heading.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(
      within(section).getByText("body").compareDocumentPosition(within(section).getByText("Speicherleiste"))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("pads the body by 24px on the sides and below and 16px under the header, and leaves a body that draws its own rows to them", () => {
    // GOAT's spacing unit is 4px (MUI's default 8px would double it): 24px is 1.5rem, 16px 1rem.
    render(
      <ThemeProvider theme={createAppTheme({ mode: "light", locale: "de" })}>
        <SettingsCard title="Padded">
          <p>padded body</p>
        </SettingsCard>
        <SettingsCard title="Rows" bodyPadding={false}>
          <p>rows body</p>
        </SettingsCard>
      </ThemeProvider>
    );
    const padded = screen.getByText("padded body").parentElement as HTMLElement;
    expect(declaredStyle(padded, "padding-left")).toBe("1.5rem");
    expect(declaredStyle(padded, "padding-right")).toBe("1.5rem");
    expect(declaredStyle(padded, "padding-bottom")).toBe("1.5rem");
    expect(declaredStyle(padded, "padding-top")).toBe("1rem");
    // Only a 12px gap under the header: the rows bring their own padding.
    const rows = screen.getByText("rows body").parentElement as HTMLElement;
    expect(declaredStyle(rows, "padding-top")).toBe("0.75rem");
    expect(declaredStyle(rows, "padding-left")).toBeUndefined();
    expect(declaredStyle(rows, "padding-bottom")).toBeUndefined();
  });
});

describe("CardSkeleton", () => {
  it("keeps the card's real header while its body loads", () => {
    wrap(<CardSkeleton title="Ihre Organisation" hint="Rolle und Teams" rows={2} />);
    const section = screen.getByRole("region", { name: "Ihre Organisation" });
    expect(within(section).getByText("Rolle und Teams")).toBeInTheDocument();
    expect(section.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(section.querySelectorAll(".MuiSkeleton-root").length).toBeGreaterThanOrEqual(2);
  });

  it("announces the loading, with a help line per field and the save bar's place when asked", () => {
    wrap(<CardSkeleton title="Persönliche Angaben" rows={2} help footer />);
    const section = screen.getByRole("region", { name: "Persönliche Angaben" });
    const status = within(section).getByRole("status", { name: "Wird geladen" });
    // Per field: the label, the field and the help line.
    expect(status.querySelectorAll(".MuiSkeleton-root")).toHaveLength(6);
    // The save bar's button, below the body.
    expect(section.querySelectorAll(".MuiSkeleton-root")).toHaveLength(7);
  });
});

describe("SettingsLoadError", () => {
  it("says the part could not be loaded and retries only it", async () => {
    const onRetry = vi.fn();
    wrap(<SettingsLoadError onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Das konnte nicht geladen werden.");
    await userEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("DangerCard", () => {
  it("offers the destructive action", async () => {
    const onClick = vi.fn();
    wrap(
      <DangerCard
        title="Konto löschen"
        text="Löscht Ihr Anmeldekonto."
        buttonLabel="Konto löschen"
        onClick={onClick}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Konto löschen" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("is disabled with its reason when the caller may not", () => {
    wrap(
      <DangerCard
        title="Organisation löschen"
        text="Beendet den Zugang."
        buttonLabel="Organisation löschen"
        onClick={vi.fn()}
        disabledReason="Nur der Eigentümer kann die Organisation löschen."
      />
    );
    const button = screen.getByRole("button", { name: "Organisation löschen" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button).toHaveAccessibleDescription("Nur der Eigentümer kann die Organisation löschen.");
  });

  it("takes a block of text as valid markup", () => {
    wrap(
      <DangerCard
        title="Team löschen"
        text={
          <ul>
            <li>eins</li>
          </ul>
        }
        buttonLabel="Team löschen"
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText("eins").closest("p")).toBeNull();
  });
});

describe("RowMenu", () => {
  it("lists its actions and runs the one chosen; a disabled one says why", async () => {
    const copy = vi.fn();
    wrap(
      <RowMenu
        label="Weitere Aktionen für Anna"
        items={[
          { key: "copy", label: "E-Mail-Adresse kopieren", onClick: copy },
          {
            key: "resend",
            label: "Einladung erneut senden",
            onClick: vi.fn(),
            disabled: true,
            reason: "Erneut senden ab 14:35 möglich.",
          },
          { key: "remove", label: "Aus Organisation entfernen", onClick: vi.fn(), danger: true },
        ]}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen für Anna" }));
    expect(
      screen.getByRole("menuitem", { name: /Einladung erneut senden/ }).getAttribute("aria-disabled")
    ).toBe("true");
    expect(screen.getByText("Erneut senden ab 14:35 möglich.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "E-Mail-Adresse kopieren" }));
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("draws nothing when there is nothing to offer", () => {
    wrap(<RowMenu label="Weitere Aktionen für Anna" items={[]} />);
    expect(screen.queryByRole("button", { name: "Weitere Aktionen für Anna" })).toBeNull();
  });

  it("writes a destructive item in error ink and the others muted", async () => {
    const theme = createAppTheme({ mode: "light", locale: "de" });
    render(
      <ThemeProvider theme={theme}>
        <RowMenu
          label="Weitere Aktionen für Anna"
          items={[
            { key: "copy", label: "E-Mail-Adresse kopieren", onClick: vi.fn() },
            { key: "remove", label: "Aus Organisation entfernen", onClick: vi.fn(), danger: true },
          ]}
        />
      </ThemeProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen für Anna" }));
    expect(screen.getByRole("menuitem", { name: "Aus Organisation entfernen" })).toHaveStyle({
      color: theme.palette.error.main,
    });
    expect(screen.getByRole("menuitem", { name: "E-Mail-Adresse kopieren" })).toHaveStyle({
      color: theme.palette.text.secondary,
    });
  });

  it("draws an item's icon before its label, as Content's row menus do", async () => {
    wrap(
      <RowMenu
        label="Weitere Aktionen für Anna"
        items={[
          { key: "copy", label: "E-Mail-Adresse kopieren", icon: ICON_NAME.COPY, onClick: vi.fn() },
          { key: "plain", label: "Ohne Symbol", onClick: vi.fn() },
        ]}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Weitere Aktionen für Anna" }));
    const copy = screen.getByRole("menuitem", { name: "E-Mail-Adresse kopieren" });
    const icon = copy.querySelector(".MuiListItemIcon-root");
    expect(icon?.querySelector("svg")).not.toBeNull();
    expect(icon?.compareDocumentPosition(within(copy).getByText("E-Mail-Adresse kopieren"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(
      screen.getByRole("menuitem", { name: "Ohne Symbol" }).querySelector(".MuiListItemIcon-root")
    ).toBeNull();
  });

  it("lets the keyboard reach a disabled item and its reason without running it", async () => {
    const resend = vi.fn();
    wrap(
      <RowMenu
        label="Weitere Aktionen für Anna"
        items={[
          { key: "copy", label: "E-Mail-Adresse kopieren", onClick: vi.fn() },
          {
            key: "resend",
            label: "Einladung erneut senden",
            onClick: resend,
            disabled: true,
            reason: "Erneut senden ab 14:35 möglich.",
          },
          { key: "remove", label: "Aus Organisation entfernen", onClick: vi.fn(), danger: true },
        ]}
      />
    );
    const trigger = screen.getByRole("button", { name: "Weitere Aktionen für Anna" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{ArrowDown}");
    await expect(screen.getByRole("menuitem", { name: /Einladung erneut senden/ })).toHaveFocus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{Enter}");
    expect(resend).not.toHaveBeenCalled();
  });
});
