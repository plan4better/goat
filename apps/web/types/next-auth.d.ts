import type { DefaultSession, DefaultUser } from "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User extends DefaultUser {
    user_roles?: string[];
  }
  interface Session extends DefaultSession {
    user?: User;
    access_token?: string;
    refresh_token?: string;
    error?: "RefreshAccessTokenError";
  }
  interface KeycloakTokenSet {
    access_token: string;
    refresh_token: string;
    id_token: string;
    expires_in: number;
    refresh_expires_in: number;
  }
}
declare module "next-auth/jwt" {
  /** Returned by the `jwt` callback and `getToken`, when using JWT sessions */
  interface JWT {
    provider: string;
    access_token: string;
    refresh_token: string;
    id_token: string;
    expires_at: number;
    user_roles?: string[];
    error?: "RefreshAccessTokenError";
  }
}

