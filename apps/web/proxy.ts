import { stackMiddlewares } from "@/middlewares/stackMiddlewares";
import { withAuth } from "@/middlewares/withAuth";
import { withCustomDomain } from "@/middlewares/withCustomDomain";
import { withLegacyRedirect } from "@/middlewares/withLegacyRedirect";
import { withOrganization } from "@/middlewares/withOrganization";

// Order: custom-domain rewrite must run BEFORE withAuth so the rewritten
// /map/public/<id> path hits withAuth's publicPaths exemption.
export default stackMiddlewares([
  withCustomDomain,
  withLegacyRedirect,
  withAuth,
  withOrganization,
]);

/**
 * The proxy runs for every request except a prefetch of a settings page.
 * Next strips `next-router-prefetch` from the request the proxy sees, so the
 * matcher is the only place to tell: without it, every settings link in view
 * would cost one core lookup in withOrganization per page view. A prefetch
 * fetches the settings shell and its loading state, nothing of the user's;
 * the click's own request still runs every check. The header is set by the
 * client, so anyone can skip the proxy here: nothing under /settings may rely
 * on it for access, and a server component, route handler or server action
 * there checks the session itself.
 */
export const config = {
  matcher: [
    { source: "/((?!settings/|settings$).*)" },
    { source: "/settings/:path*", missing: [{ type: "header", key: "next-router-prefetch" }] },
  ],
};
