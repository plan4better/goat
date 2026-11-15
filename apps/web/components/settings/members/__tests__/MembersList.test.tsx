import { act, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import MembersList from "@/components/settings/members/MembersList";
import type { MemberRow } from "@/components/settings/members/memberRows";

const invitation: MemberRow = {
  id: "i1",
  name: "i1@example.com",
  email: "i1@example.com",
  avatar: null,
  role: "organization-editor",
  pending: true,
  isSelf: false,
  invitedAt: "2026-11-02T14:30:00",
  lastSentAt: "2026-11-02T14:30:00",
};

describe("MembersList", () => {
  afterEach(() => vi.useRealTimers());

  it("moves its relative dates on with the clock, without the page rendering it again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T14:30:00Z"));
    render(
      <I18nextProvider i18n={commonI18n("en")}>
        <MembersList
          rows={[invitation]}
          total={1}
          page={1}
          onPage={vi.fn()}
          sort={{ key: "role", dir: "asc" }}
          onSort={vi.fn()}
          chips={[]}
          onClearAll={vi.fn()}
          isLoading={false}
          emptyTitle=""
          emptyHint=""
          renderRole={() => null}
          renderActions={() => null}
        />
      </I18nextProvider>
    );
    expect(screen.getByText("Invited less than a minute ago")).toBeInTheDocument();
    expect(screen.getByText("sent less than a minute ago")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(screen.getByText("Invited 3 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("sent 3 minutes ago")).toBeInTheDocument();
  });
});
