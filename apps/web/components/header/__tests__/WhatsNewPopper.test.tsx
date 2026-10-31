import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseEntry } from "@/lib/validations/home";

import WhatsNewPopper from "@/components/header/WhatsNewPopper";

const { useReleasesMock, usePreferencesMock, patchPreferencesMock, mutateMock } = vi.hoisted(() => ({
  useReleasesMock: vi.fn(),
  usePreferencesMock: vi.fn(),
  patchPreferencesMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/api/feeds", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/feeds")>("@/lib/api/feeds");
  return {
    ...actual,
    FEEDS_ENABLED: true,
    changelogUrl: () => "https://www.plan4better.de/en/goat/changelog",
  };
});
vi.mock("@/lib/api/releases", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/releases")>("@/lib/api/releases");
  return { ...actual, useReleases: useReleasesMock };
});
vi.mock("@/lib/api/preferences", () => ({
  usePreferences: usePreferencesMock,
  patchPreferences: patchPreferencesMock,
}));

const entry = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  id: "e1",
  date: "2026-09-04",
  tag: "new",
  title: "Content Spaces",
  summary: "Spaces now own content.",
  url: "https://www.plan4better.de/en/goat/changelog/2026-09#content-spaces",
  ...overrides,
});

beforeEach(() => {
  useReleasesMock.mockReset();
  usePreferencesMock.mockReset();
  patchPreferencesMock.mockReset().mockResolvedValue({});
  mutateMock.mockReset();
});

describe("WhatsNewPopper", () => {
  it("badges the icon with the count of entries newer than releases_seen_at", () => {
    useReleasesMock.mockReturnValue({
      entries: [entry({ id: "e1", date: "2026-09-04" }), entry({ id: "e2", date: "2026-08-01" })],
      isLoading: false,
      isError: undefined,
    });
    usePreferencesMock.mockReturnValue({
      preferences: {
        onboarding_skipped_at: null,
        releases_seen_at: "2026-08-15T00:00:00.000Z",
        spotlight_seen: [],
      },
      isLoading: false,
      mutate: mutateMock,
    });

    render(<WhatsNewPopper />);

    expect(screen.getByText("1")).toBeInTheDocument();
    // The badge reaches past the icon: the button keeps a little room before Ask AI.
    expect(getComputedStyle(screen.getByRole("button", { name: "whats_new" })).marginRight).toBe("4px");
  });

  it("shows no badge while the preferences are still loading", () => {
    useReleasesMock.mockReturnValue({
      entries: [entry(), entry({ id: "e2" })],
      isLoading: false,
      isError: undefined,
    });
    usePreferencesMock.mockReturnValue({ preferences: undefined, isLoading: true, mutate: mutateMock });

    render(<WhatsNewPopper />);

    expect(screen.queryByText("2")).toBeNull();
  });

  it("patches releases_seen_at to now and refreshes preferences when opened", () => {
    useReleasesMock.mockReturnValue({ entries: [entry()], isLoading: false, isError: undefined });
    usePreferencesMock.mockReturnValue({
      preferences: { onboarding_skipped_at: null, releases_seen_at: null, spotlight_seen: [] },
      isLoading: false,
      mutate: mutateMock,
    });

    render(<WhatsNewPopper />);
    fireEvent.click(screen.getByRole("button"));

    expect(patchPreferencesMock).toHaveBeenCalledTimes(1);
    const [update] = patchPreferencesMock.mock.calls[0] as [{ releases_seen_at: string }];
    expect(Object.keys(update)).toEqual(["releases_seen_at"]);
    expect(() => new Date(update.releases_seen_at).toISOString()).not.toThrow();
    expect(screen.getByText("Content Spaces")).toBeInTheDocument();
  });

  it("does not patch releases_seen_at when the popper is closed again", () => {
    useReleasesMock.mockReturnValue({ entries: [entry()], isLoading: false, isError: undefined });
    usePreferencesMock.mockReturnValue({
      preferences: { onboarding_skipped_at: null, releases_seen_at: null, spotlight_seen: [] },
      isLoading: false,
      mutate: mutateMock,
    });

    render(<WhatsNewPopper />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);

    expect(patchPreferencesMock).toHaveBeenCalledTimes(1);
  });
});
