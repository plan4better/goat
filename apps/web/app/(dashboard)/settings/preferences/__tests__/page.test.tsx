import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { toast } from "react-toastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { ColorModeContext } from "@/components/@mui/ThemeRegistry";

import PreferencesPage from "@/app/(dashboard)/settings/preferences/page";

const api = vi.hoisted(() => ({ updateSystemSettings: vi.fn() }));
vi.mock("@/lib/api/system/client", () => ({ updateSystemSettings: api.updateSystemSettings }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const changeColorMode = vi.fn();
const fetchMock = vi.fn();

const renderPage = (i18n = commonI18n("de")) => {
  render(
    <I18nextProvider i18n={i18n}>
      <ColorModeContext.Provider value={{ changeColorMode }}>
        <PreferencesPage />
      </ColorModeContext.Provider>
    </I18nextProvider>
  );
  return i18n;
};

describe("Language and appearance", () => {
  beforeEach(() => {
    api.updateSystemSettings.mockReset().mockImplementation(async (body) => body);
    fetchMock.mockReset().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    changeColorMode.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves a language at once and confirms in the new language", async () => {
    const i18n = renderPage();
    await expect(screen.getByRole("radio", { name: /^Deutsch/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: /^English/ }));
    expect(api.updateSystemSettings).toHaveBeenCalledWith({
      preferred_language: "en",
      client_theme: "light",
      unit: "metric",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preferences/update",
      expect.objectContaining({ method: "POST" })
    );
    expect(i18n.language).toBe("en");
    expect(toast.success).toHaveBeenCalledWith("Saved.");
  });

  it("saves the appearance at once", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Dunkel/ }));
    expect(api.updateSystemSettings).toHaveBeenCalledWith({
      preferred_language: "de",
      client_theme: "dark",
      unit: "metric",
    });
    expect(changeColorMode).toHaveBeenCalledWith("dark");
    expect(toast.success).toHaveBeenCalledWith("Erscheinungsbild: Dunkel.");
  });

  it("puts the previous choice back when saving fails", async () => {
    api.updateSystemSettings.mockRejectedValue(new Error("500"));
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Dunkel/ }));
    expect(toast.error).toHaveBeenCalledWith("Ihre Einstellungen konnten nicht gespeichert werden.");
    await expect(screen.getByRole("radio", { name: /^Hell/ })).toHaveAttribute("aria-checked", "true");
    expect(changeColorMode).not.toHaveBeenCalled();
  });

  it("counts a refused preference cookie as a failure", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Dunkel/ }));
    expect(toast.error).toHaveBeenCalledWith("Ihre Einstellungen konnten nicht gespeichert werden.");
    await expect(screen.getByRole("radio", { name: /^Hell/ })).toHaveAttribute("aria-checked", "true");
    expect(changeColorMode).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("holds the other choices while a pick saves", async () => {
    let finish!: () => void;
    api.updateSystemSettings.mockImplementation(
      (body) =>
        new Promise((resolve) => {
          finish = () => resolve(body);
        })
    );
    renderPage();
    await userEvent.click(screen.getByRole("radio", { name: /^Dunkel/ }));
    await expect(screen.getByRole("radio", { name: /^Hell/ })).toHaveAttribute("aria-disabled", "true");
    await expect(screen.getByRole("radio", { name: /^English/ })).toHaveAttribute("aria-disabled", "true");
    await expect(screen.getByRole("radio", { name: /^Dunkel/ })).not.toHaveAttribute("aria-disabled");
    await userEvent.click(screen.getByRole("radio", { name: /^English/ }));
    expect(api.updateSystemSettings).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(toast.success).toHaveBeenCalledWith("Erscheinungsbild: Dunkel.");
    await expect(screen.getByRole("radio", { name: /^Hell/ })).not.toHaveAttribute("aria-disabled");
    await expect(screen.getByRole("radio", { name: /^English/ })).not.toHaveAttribute("aria-disabled");
  });
});
