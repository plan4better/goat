import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RichTextEditor from "@/components/builder/widgets/common/RichTextEditor";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const text = (container: HTMLElement) => container.querySelector(".ProseMirror")?.textContent;

describe("RichTextEditor alwaysEdit", () => {
  it("shows the new value when it changes from outside while unfocused", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <RichTextEditor value="<p>First</p>" onChange={onChange} alwaysEdit singleLine />
    );
    expect(text(container)).toBe("First");

    rerender(<RichTextEditor value="<p>Second</p>" onChange={onChange} alwaysEdit singleLine />);
    expect(text(container)).toBe("Second");
    // Syncing an external value is not a user edit and must not be saved back.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not overwrite the content while the editor is focused", () => {
    const { container, rerender } = render(
      <RichTextEditor value="<p>First</p>" onChange={vi.fn()} alwaysEdit singleLine />
    );
    const dom = container.querySelector(".ProseMirror") as HTMLElement;
    act(() => dom.focus());

    rerender(<RichTextEditor value="<p>Lagging</p>" onChange={vi.fn()} alwaysEdit singleLine />);
    expect(text(container)).toBe("First");
  });
});
