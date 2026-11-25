import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/apiError";
import { TEAMS_API_BASE_URL, changeTeamOwner, teamsScopeOf, useTeams } from "@/lib/api/teams";

const { fetchMock, swrMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  swrMock: vi.fn((_key: unknown, _fetcher: unknown) => ({
    data: undefined,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
    isValidating: false,
  })),
}));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: vi.fn() }));
vi.mock("@/lib/api/useAuthedSWR", () => ({ useAuthedSWR: swrMock }));
vi.mock("swr", () => ({ default: vi.fn(() => ({})), mutate: vi.fn() }));

describe("useTeams", () => {
  beforeEach(() => swrMock.mockClear());

  it("keeps the caller's own teams on the bare key the share dialogs and Home share", () => {
    renderHook(() => useTeams());
    expect(swrMock.mock.calls[0][0]).toBe(TEAMS_API_BASE_URL);
  });

  it("asks for the whole organization with scope=organization, and for nothing while disabled", () => {
    renderHook(() => useTeams({ scope: "organization" }));
    expect(swrMock.mock.calls[0][0]).toBe(`${TEAMS_API_BASE_URL}?scope=organization`);
    renderHook(() => useTeams({ scope: "organization", enabled: false }));
    expect(swrMock.mock.calls[1][0]).toBeNull();
  });
});

describe("teamsScopeOf", () => {
  it("gives owners and admins the organization, everyone else their own teams, and waits for the roles", () => {
    expect(teamsScopeOf(["organization-owner"])).toBe("organization");
    expect(teamsScopeOf(["organization-admin"])).toBe("organization");
    expect(teamsScopeOf(["organization-editor"])).toBe("mine");
    expect(teamsScopeOf([])).toBe("mine");
    expect(teamsScopeOf(undefined)).toBeUndefined();
  });
});

describe("changeTeamOwner", () => {
  beforeEach(() => fetchMock.mockReset());

  it("puts the new owner and answers the team's members", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ id: "u2", role: "team-owner" }]),
    });
    await expect(changeTeamOwner("t1", "u2")).resolves.toEqual([{ id: "u2", role: "team-owner" }]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${TEAMS_API_BASE_URL}/t1/owner`);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ user_id: "u2" });
  });

  it("keeps core's status and detail when it refuses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ detail: "A viewer cannot own a team" }),
    });
    const error = await changeTeamOwner("t1", "u3").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, detail: "A viewer cannot own a team" });
  });

  it("keeps the 409 of a new owner who left the team meanwhile", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ detail: "The person is no longer a member of the team" }),
    });
    const error = await changeTeamOwner("t1", "u2").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409 });
  });
});
