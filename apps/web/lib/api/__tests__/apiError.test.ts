import { describe, expect, it } from "vitest";

import { ApiError, apiErrorOf, detailOf, statusOf } from "@/lib/api/apiError";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("apiErrorOf", () => {
  it("keeps the status and core's detail", async () => {
    const error = await apiErrorOf(json(400, { detail: "User has already been invited" }));
    expect(error).toBeInstanceOf(ApiError);
    expect(statusOf(error)).toBe(400);
    expect(detailOf(error)).toBe("User has already been invited");
  });

  it("keeps the status of an answer without a JSON body", async () => {
    const error = await apiErrorOf(new Response("Bad gateway", { status: 502 }));
    expect(statusOf(error)).toBe(502);
    expect(detailOf(error)).toBeUndefined();
  });

  it("drops a detail that is not text (validation errors)", async () => {
    const error = await apiErrorOf(json(422, { detail: [{ loc: ["body"], msg: "bad" }] }));
    expect(detailOf(error)).toBeUndefined();
  });

  it("reads the status and detail of an SWR fetcher error too", () => {
    const fetcherError = Object.assign(new Error("x"), { status: 403, info: { detail: "no" } });
    expect(statusOf(fetcherError)).toBe(403);
    expect(detailOf(fetcherError)).toBe("no");
    expect(statusOf("nope")).toBeUndefined();
  });
});
