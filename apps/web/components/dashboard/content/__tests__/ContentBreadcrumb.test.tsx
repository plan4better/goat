import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Space } from "@/lib/validations/content";

import ContentBreadcrumb from "@/components/dashboard/content/ContentBreadcrumb";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const crumb = (props: Partial<React.ComponentProps<typeof ContentBreadcrumb>> = {}) => (
  <ContentBreadcrumb folders={[]} folderId={null} onNavigate={() => {}} {...props} />
);

describe("ContentBreadcrumb", () => {
  it("holds the space's place with a placeholder while it is unknown", () => {
    const { container } = render(crumb({ loading: true }));

    expect(container.querySelector(".MuiSkeleton-root")).not.toBeNull();
    expect(screen.queryByText("…")).not.toBeInTheDocument();
  });

  it("names the space once it is there", () => {
    const { container } = render(
      crumb({
        loading: true,
        space: {
          id: "00000000-0000-0000-0000-00000000000b",
          kind: "team",
          name: "Planning",
          default_role: "viewer",
        } as Space,
      })
    );

    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(container.querySelector(".MuiSkeleton-root")).toBeNull();
  });

  const folders = [
    { id: "f-root", name: "home", parent_id: null },
    { id: "f-work", name: "Work", parent_id: "f-root" },
    { id: "f-shared", name: "Templates", parent_id: "f-work" },
    { id: "f-inner", name: "Berlin", parent_id: "f-shared" },
  ] as unknown as React.ComponentProps<typeof ContentBreadcrumb>["folders"];

  const space = {
    id: "00000000-0000-0000-0000-00000000000b",
    kind: "organization",
    name: "Organization",
    default_role: "viewer",
  } as Space;

  it("starts the trail at the folder shared into the space", () => {
    render(crumb({ space, folders, folderId: "f-inner", rootFolderId: "f-shared" }));

    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.queryByText("Work")).not.toBeInTheDocument();
    expect(screen.getByText("Templates")).toBeInTheDocument();
    expect(screen.getByText("Berlin")).toBeInTheDocument();
  });

  it("stands in the shared view's place when the address names a space nobody can see", () => {
    const onNavigateView = vi.fn();
    render(
      crumb({
        folders,
        folderId: "f-shared",
        fallbackView: "shared_with_me",
        onNavigateView,
      })
    );

    expect(screen.queryByText("…")).not.toBeInTheDocument();
    expect(screen.getByText("Templates")).toBeInTheDocument();
    screen.getByText("shared_with_me").click();
    expect(onNavigateView).toHaveBeenCalledWith("shared_with_me");
  });
});
