/**
 * How long before its expiry an access token is replaced. The client asks for
 * the session's token again once less than this is left (lib/api/fetcher.ts),
 * and the session refreshes a token with less than this left
 * (app/api/auth/[...nextauth]/options.ts): handed out as it was, a token that
 * close to its expiry could expire before the request it was fetched for
 * reaches the API, which then refuses it.
 */
export const TOKEN_REFRESH_BUFFER_MS = 10_000;
