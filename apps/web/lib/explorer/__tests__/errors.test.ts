// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ExplorerLoadError,
  explain,
  kindOfBuildFailure,
  kindOfStatus,
  retryable,
} from "@/lib/explorer/errors";

describe("Explorer errors", () => {
  it("reads HTTP statuses as what a planner can do about them", () => {
    expect(kindOfStatus(404)).toBe("not_found");
    expect(kindOfStatus(403)).toBe("forbidden");
    expect(kindOfStatus(503)).toBe("unreachable");
    expect(kindOfStatus(504)).toBe("unreachable");
    expect(kindOfStatus(401)).toBe("other");
  });

  it("reads the server's reasons for a failed build", () => {
    expect(kindOfBuildFailure("The bundle has no stop_times layer")).toBe("incomplete");
    expect(kindOfBuildFailure("The bundle has neither a calendar nor calendar_dates layer")).toBe(
      "incomplete"
    );
    expect(kindOfBuildFailure("Out of Memory Error: could not allocate block of size 256 KiB")).toBe(
      "memory_server"
    );
    expect(kindOfBuildFailure("connection to server was lost")).toBe("other");
  });

  it("tells the browser's own failures apart", () => {
    expect(explain(new TypeError("Failed to fetch")).kind).toBe("unreachable");
    expect(explain(new Error("Out of Memory Error: failed to allocate data of size 64 MiB")).kind).toBe(
      "memory_browser"
    );
    expect(explain(new ExplorerLoadError("forbidden", "Explorer snapshot: 403 Forbidden"))).toEqual({
      kind: "forbidden",
      detail: "Explorer snapshot: 403 Forbidden",
    });
    expect(explain("odd").kind).toBe("other");
  });

  it("offers trying again only where it can help", () => {
    expect(retryable("unreachable")).toBe(true);
    expect(retryable("memory_server")).toBe(true);
    expect(retryable("not_found")).toBe(false);
    expect(retryable("incomplete")).toBe(false);
  });
});
