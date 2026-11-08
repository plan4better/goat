import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import ImagePicker, { IMAGE_MAX_BYTES } from "@/components/settings/common/ImagePicker";

const renderPicker = (onChange = vi.fn()) => {
  render(
    <I18nextProvider i18n={commonI18n("de")}>
      <ImagePicker
        id="avatar"
        name="Anna Weber"
        seed="u1"
        onChange={onChange}
        buttonLabel="Bild hochladen"
        hint="PNG, JPG oder GIF, höchstens 1 MB."
      />
    </I18nextProvider>
  );
  return { onChange, input: document.getElementById("avatar") as HTMLInputElement };
};

const HINT = "PNG, JPG oder GIF, höchstens 1 MB.";
const png = () => new File(["png"], "a.png", { type: "image/png" });

describe("ImagePicker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the initials without a picture and accepts only PNG, JPG and GIF", () => {
    const { input } = renderPicker();
    expect(screen.getByText("AW")).toBeInTheDocument();
    expect(input.accept).toBe("image/png,image/jpeg,image/gif");
  });

  it("reads a small PNG into the card's draft as a data URL", async () => {
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { files: [new File(["png"], "a.png", { type: "image/png" })] } });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/))
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses an SVG and a picture over 1 MB, saying why", () => {
    const { input, onChange } = renderPicker();
    fireEvent.change(input, {
      target: { files: [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Wählen Sie eine PNG-, JPG- oder GIF-Datei.");
    const big = new File([new Uint8Array(IMAGE_MAX_BYTES + 1)], "big.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [big] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Das Bild ist größer als 1 MB.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("describes its button by the hint, and by the problem while there is one", () => {
    const { input } = renderPicker();
    expect(screen.getByRole("button", { name: "Bild hochladen", description: HINT })).toBeInTheDocument();
    fireEvent.change(input, {
      target: { files: [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })] },
    });
    expect(
      screen.getByRole("button", {
        name: "Bild hochladen",
        description: `${HINT} Wählen Sie eine PNG-, JPG- oder GIF-Datei.`,
      })
    ).toBeInTheDocument();
  });

  it("says so when the file cannot be read", () => {
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
    });
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { files: [png()] } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Die Datei ließ sich nicht lesen. Wählen Sie sie erneut."
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
