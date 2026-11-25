"use client";

import Cookies from "js-cookie";
import { useState } from "react";

import { useOrganization } from "@/lib/api/users";

/** Set on every protected request by `middlewares/withOrganization.ts` (not httpOnly). */
export const ORGANIZATION_COOKIE = "organization";

/**
 * The caller's organization id without waiting for `GET /users/organization`
 * (Settings load, L4): that answer once it is there, the middleware's cookie
 * until then. A stale cookie (the user moved organization) costs one refused
 * request before the answer takes over.
 */
export function useOrganizationId(): string | undefined {
  const { organization } = useOrganization();
  const [cookieId] = useState(() =>
    typeof document === "undefined" ? undefined : Cookies.get(ORGANIZATION_COOKIE) || undefined
  );
  return organization?.id ?? cookieId;
}
