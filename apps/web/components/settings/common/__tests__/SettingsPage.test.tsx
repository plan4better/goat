import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsPage from "@/components/settings/common/SettingsPage";

/** The nearest ancestor that scrolls, or null. */
const scrollerOf = (element: Element) => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "auto") return node;
  }
  return null;
};

const page = (body = "first card") => (
  <SettingsPage header={<PageHeader level={2} eyebrow="Account" title="Profile" subtitle="Who you are." />}>
    <section>{body}</section>
    <section>second card</section>
  </SettingsPage>
);

describe("SettingsPage", () => {
  it("lays out its heading first, then the cards, and scrolls with the layout's area, not on its own", () => {
    const { container } = render(page());
    const heading = screen.getByRole("heading", { level: 2, name: "Profile" });
    for (const element of [heading, screen.getByText("first card"), screen.getByText("second card")]) {
      expect(scrollerOf(element)).toBeNull();
    }
    expect(getComputedStyle(container.firstElementChild as Element).overflowY).not.toBe("auto");
    expect(
      heading.compareDocumentPosition(screen.getByText("first card")) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("is the frame of a page without a heading of its own too, again without a scroll area", () => {
    const { container } = render(
      <SettingsPage>
        <section>only card</section>
      </SettingsPage>
    );
    expect(container.firstElementChild).toContainElement(screen.getByText("only card"));
    expect(scrollerOf(screen.getByText("only card"))).toBeNull();
  });
});
