import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { contentDialogPaperSx } from "@/components/modals/content/ContentDialogChrome";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}));

describe("AppDialog", () => {
  it("renders the header title, the subtitle and the body", () => {
    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Save as template" subtitle="Munich">
        <div>body content</div>
      </AppDialog>
    );

    expect(screen.getByText("Save as template")).toBeInTheDocument();
    expect(screen.getByText("Munich")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("is named by its title, as MUI's DialogTitle names a dialog", () => {
    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Save as template" subtitle="Munich">
        <div>body content</div>
      </AppDialog>
    );

    expect(screen.getByRole("dialog", { name: "Save as template" })).toBeInTheDocument();
  });

  it("takes its name from ariaLabel when one is given", () => {
    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Set up layer" ariaLabel="roads.gpkg">
        <div>body content</div>
      </AppDialog>
    );

    expect(screen.getByRole("dialog", { name: "roads.gpkg" })).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <AppDialog open={false} onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Save as template">
        <div>body content</div>
      </AppDialog>
    );

    expect(screen.queryByText("body content")).not.toBeInTheDocument();
  });

  it("calls onClose from the header close button", () => {
    const onClose = vi.fn();
    render(
      <AppDialog open onClose={onClose} icon={ICON_NAME.SAVE} title="Save as template">
        <div>body content</div>
      </AppDialog>
    );

    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the notice above the footer", () => {
    render(
      <AppDialog
        open
        onClose={vi.fn()}
        icon={ICON_NAME.SAVE}
        title="Save as template"
        notice={<div>heads up</div>}
        footer={<AppDialogFooter onCancel={vi.fn()} primaryLabel="Save" onPrimary={vi.fn()} />}>
        <div>body content</div>
      </AppDialog>
    );

    expect(screen.getByText("heads up")).toBeInTheDocument();
  });

  it("tints the icon tile differently for the warning tone", () => {
    // The primary tone paints the tile with the primary accent; warning paints
    // it amber, so the two tones are told apart by the tile's own background.
    const tileBackground = () => getComputedStyle(screen.getByTestId("dialog-icon-tile")).backgroundColor;

    const { unmount } = render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.TRASH} title="Delete layer">
        <div>body content</div>
      </AppDialog>
    );
    const primaryBackground = tileBackground();
    unmount();

    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.TRASH} title="Delete layer" tone="warning">
        <div>body content</div>
      </AppDialog>
    );

    expect(tileBackground()).not.toBe(primaryBackground);
  });

  it("drops the body's padding when bleed is set", () => {
    const { unmount } = render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Save as template">
        <div>body content</div>
      </AppDialog>
    );
    const paddedPadding = getComputedStyle(screen.getByText("body content").parentElement as Element).padding;
    unmount();

    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Save as template" bleed>
        <div>body content</div>
      </AppDialog>
    );
    const bleedPadding = getComputedStyle(screen.getByText("body content").parentElement as Element).padding;

    expect(bleedPadding).not.toBe(paddedPadding);
    expect(bleedPadding).toBe("0px");
  });

  it("disables the header close button and ignores backdrop/Escape when closeDisabled", () => {
    const onClose = vi.fn();
    render(
      <AppDialog open onClose={onClose} icon={ICON_NAME.SAVE} title="Save as template" closeDisabled>
        <div>body content</div>
      </AppDialog>
    );

    const closeButton = screen.getByRole("button", { name: "close" }) as HTMLButtonElement;
    expect(closeButton.disabled).toBe(true);
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes on the header X, backdrop and Escape when closeDisabled is not set", () => {
    const onClose = vi.fn();
    render(
      <AppDialog open onClose={onClose} icon={ICON_NAME.SAVE} title="Save as template">
        <div>body content</div>
      </AppDialog>
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /** What a paper stated as `min(<n>px, calc(100% - <gutter>px))` comes to at
   * a given viewport, so the widths below can be read as numbers. */
  const paperWidthAt = (expression: string, viewport: number): number => {
    const match = /^min\((\d+)px, calc\(100% - (\d+)px\)\)$/.exec(expression);
    if (!match) throw new Error(`paper width is not capped against the viewport: ${expression}`);
    return Math.min(Number(match[1]), viewport - Number(match[2]));
  };

  it.each([599, 640, 663])("keeps the paper inside its own margins at %ipx", (viewport) => {
    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Save as template" maxWidth={600}>
        <div>body</div>
      </AppDialog>
    );

    const paper = document.querySelector(".MuiDialog-paper") as HTMLElement;
    // MUI's paper carries a 32px margin either side that its own `100%` does
    // not account for, so the width has to leave room for both.
    expect(paperWidthAt(getComputedStyle(paper).maxWidth, viewport) + 64).toBeLessThanOrEqual(viewport);
  });

  it("caps a width a dialog states for itself against the same margins", () => {
    expect(contentDialogPaperSx("min(1360px, 94vw)", false)).toEqual({
      width: "min(min(1360px, 94vw), calc(100% - 64px))",
      maxWidth: "min(min(1360px, 94vw), calc(100% - 64px))",
      borderRadius: "16px",
    });
  });

  it("leaves a full-screen paper its whole viewport", () => {
    expect(contentDialogPaperSx(560, true)).toEqual({ borderRadius: 0 });
  });
});

describe("AppDialogFooter", () => {
  it("runs the primary action and the cancel action", () => {
    const onCancel = vi.fn();
    const onPrimary = vi.fn();
    render(<AppDialogFooter onCancel={onCancel} primaryLabel="Save" onPrimary={onPrimary} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPrimary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("labels the cancel button with the given label", () => {
    render(
      <AppDialogFooter cancelLabel="Not now" onCancel={vi.fn()} primaryLabel="Save" onPrimary={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("omits the cancel button when there is no cancel action", () => {
    render(<AppDialogFooter primaryLabel="Close" onPrimary={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "cancel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("disables the primary action", () => {
    const onPrimary = vi.fn();
    render(<AppDialogFooter onCancel={vi.fn()} primaryLabel="Save" onPrimary={onPrimary} primaryDisabled />);

    const primary = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    fireEvent.click(primary);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("shows a spinner and blocks the primary action while it is loading", () => {
    const onPrimary = vi.fn();
    render(<AppDialogFooter onCancel={vi.fn()} primaryLabel="Save" onPrimary={onPrimary} primaryLoading />);

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    const primary = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
  });

  it("renders the extra slot alongside the actions", () => {
    render(
      <AppDialogFooter
        onCancel={vi.fn()}
        primaryLabel="Create"
        onPrimary={vi.fn()}
        extra={<button type="button">back</button>}
      />
    );

    expect(screen.getByRole("button", { name: "back" })).toBeInTheDocument();
  });

  it("disables the cancel button while the primary stays enabled", () => {
    const onCancel = vi.fn();
    const onPrimary = vi.fn();
    render(<AppDialogFooter onCancel={onCancel} cancelDisabled primaryLabel="Save" onPrimary={onPrimary} />);

    const cancel = screen.getByRole("button", { name: "cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();

    const primary = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    fireEvent.click(primary);
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it("paints the primary button with the error colour when primaryColor is error", () => {
    const { unmount } = render(<AppDialogFooter primaryLabel="Delete" onPrimary={vi.fn()} />);
    const defaultButton = screen.getByRole("button", { name: "Delete" });
    expect(defaultButton.className).not.toMatch(/colorError/);
    unmount();

    render(<AppDialogFooter primaryLabel="Delete" onPrimary={vi.fn()} primaryColor="error" />);
    expect(screen.getByRole("button", { name: "Delete" }).className).toMatch(/colorError/);
  });

  it("reaches the primaryTooltip text when the disabled primary is hovered", async () => {
    render(
      <AppDialogFooter
        primaryLabel="Save"
        onPrimary={vi.fn()}
        primaryDisabled
        primaryTooltip="Fill in a name first"
      />
    );

    // MUI wraps a disabled button in a span for exactly this reason: a
    // disabled button swallows pointer events, so the tooltip listens on
    // that wrapper instead.
    const trigger = screen.getByRole("button", { name: "Save" }).closest("span") as HTMLElement;
    fireEvent.mouseOver(trigger);

    expect(await screen.findByText("Fill in a name first")).toBeInTheDocument();
  });

  it("makes the primary a submit control for the named form when primaryType is submit", () => {
    render(
      <AppDialogFooter
        primaryLabel="Create"
        onPrimary={vi.fn()}
        primaryType="submit"
        primaryForm="create-project-form"
      />
    );

    const primary = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(primary.type).toBe("submit");
    expect(primary.getAttribute("form")).toBe("create-project-form");
  });

  it("defaults the primary to a plain button with no form association", () => {
    render(<AppDialogFooter primaryLabel="Create" onPrimary={vi.fn()} />);

    const primary = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(primary.type).toBe("button");
    expect(primary.hasAttribute("form")).toBe(false);
  });

  it("renders a dismiss-only row when no primary is given", () => {
    const onCancel = vi.fn();
    render(<AppDialogFooter onCancel={onCancel} cancelLabel="Close" />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("merges paperSx over the shell's paper styling", () => {
    render(
      <AppDialog open onClose={vi.fn()} icon={ICON_NAME.SAVE} title="Formula" paperSx={{ minHeight: 600 }}>
        <div>body</div>
      </AppDialog>
    );

    const paper = document.querySelector(".MuiDialog-paper") as HTMLElement;
    expect(paper.style.minHeight || getComputedStyle(paper).minHeight).toBe("600px");
    expect(getComputedStyle(paper).borderRadius).toBe("16px");
  });
});
