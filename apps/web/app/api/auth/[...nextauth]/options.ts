import type { KeycloakTokenSet, NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import KeycloakProvider from "next-auth/providers/keycloak";

import { serverKeycloakClientId, serverKeycloakIssuer } from "@/lib/utils/server-env";
import { TOKEN_REFRESH_BUFFER_MS } from "@/lib/utils/token-refresh";

const keycloak = KeycloakProvider({
  id: "keycloak",
  clientId: serverKeycloakClientId() as string,
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET as string,
  issuer: serverKeycloakIssuer(),
  authorization: { params: { scope: "openid email profile offline_access" } },
});

// this performs the final handshake for the keycloak provider
export async function doFinalSignoutHandshake(token: JWT) {
  if (token.provider == keycloak.id) {
    try {
      const issuerUrl = keycloak.options?.issuer;
      const logOutUrl = new URL(`${issuerUrl}/protocol/openid-connect/logout`);
      logOutUrl.searchParams.set("id_token_hint", token.id_token);
      const { status, statusText } = await fetch(logOutUrl);
      console.log("Completed post-logout handshake", status, statusText);
    } catch {
      console.error("Unable to perform post-logout handshake");
    }
  }
}

export async function refreshAccessToken(token: JWT): Promise<JWT> {
  try {
    const response = await fetch(`${keycloak.options?.issuer}/protocol/openid-connect/token`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: keycloak.options?.clientId as string,
        client_secret: keycloak.options?.clientSecret as string,
        grant_type: "refresh_token",
        refresh_token: token.refresh_token as string,
      }),
      method: "POST",
    });

    const tokensRaw = await response.json();
    const tokens: KeycloakTokenSet = tokensRaw;
    if (!response.ok) throw tokens;

    const expiresAt = Math.floor(Date.now() / 1000 + tokens.expires_in);
    console.log(`Token was refreshed. New token expires in ${tokens.expires_in} sec at ${expiresAt}`);
    const newToken: JWT = {
      ...token,
      access_token: tokens.access_token,
      expires_at: expiresAt,
      refresh_token: tokens.refresh_token ?? token.refresh_token,
      id_token: tokens.id_token ?? token.id_token,
      provider: keycloak.id,
    };
    return newToken;
  } catch (error) {
    console.error("Error refreshing access token: ", error);
    return {
      ...token,
      error: "RefreshAccessTokenError",
    };
  }
}

export const options: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [keycloak],
  callbacks: {
    async session({ session, token }) {
      if (token) {
        session.access_token = token.access_token;
        session.refresh_token = token.refresh_token;
        session.error = token.error;
      }
      return session;
    },
    async jwt({ token, account, user }) {
      if (account && user) {
        if (!account.access_token) throw Error("Auth Provider missing access token");
        if (!account.refresh_token) throw Error("Auth Provider missing refresh token");
        if (!account.id_token) throw Error("Auth Provider missing ID token");
        const newToken: JWT = {
          ...token,
          access_token: account.access_token,
          refresh_token: account.refresh_token,
          id_token: account.id_token,
          expires_at: Math.floor(account.expires_at ?? 0),
          provider: account.provider,
        };

        return newToken;
      }
      // Refreshed while it is still valid, once less than the client's buffer is left: the
      // client asks again at that point, and the token it gets must outlast its requests.
      if (Date.now() < token.expires_at * 1000 - TOKEN_REFRESH_BUFFER_MS) {
        return token;
      }
      const newToken = await refreshAccessToken(token);
      // A refresh that fails while the current token is still valid (Keycloak briefly
      // unreachable or refusing) keeps that token as it is, without the error that sends the
      // user to sign in: it still works, and the next call tries the refresh again. Only a
      // failed refresh after expiry, when no usable token is left, carries the error.
      if (newToken.error && Date.now() < token.expires_at * 1000) {
        return token;
      }
      return newToken;
    },
  },
  events: {
    signOut: async ({ token }) => doFinalSignoutHandshake(token),
  },
  pages: {
    signIn: "/auth/login",
  },
  session: {
    strategy: "jwt",
    // Upper bound for the session cookie only. The real session length is
    // governed by Keycloak (SSO idle/max timeouts): when the refresh token
    // dies, refreshAccessToken flags the session and the app forces re-login.
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
};
