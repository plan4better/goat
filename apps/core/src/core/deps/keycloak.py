import asyncio
import logging
from typing import Any

from core.core.config import settings
from keycloak import KeycloakAdmin, KeycloakOpenIDConnection
from keycloak.exceptions import KeycloakError, KeycloakGetError, KeycloakPostError

logger = logging.getLogger(__name__)

_admin: KeycloakAdmin | None = None

# Required actions of an account created for an invitee, and how long (in
# seconds) the emailed link to complete them stays valid.
INVITED_USER_ACTIONS = ["UPDATE_PASSWORD"]
INVITED_USER_ACTIONS_LIFESPAN = 7 * 24 * 60 * 60


async def keycloak_admin() -> KeycloakAdmin | None:
    """Admin client for the configured realm, authenticated as a service account
    via the client-credentials grant (least-privilege; no master-realm admin).

    Returns ``None`` when the service-account client isn't configured, so callers
    degrade gracefully (skip Keycloak enrichment / writes) instead of crashing.

    The client is created once and reused — python-keycloak obtains its token
    lazily and refreshes it when expired, so rebuilding per request would cost
    an extra token grant on every call.
    """
    global _admin
    if not (settings.KEYCLOAK_CLIENT_ID and settings.KEYCLOAK_CLIENT_SECRET):
        return None
    if _admin is None:
        connection = KeycloakOpenIDConnection(
            # python-keycloak joins its paths onto server_url with urljoin, which
            # drops a last path segment (e.g. /keycloak) without a trailing slash.
            server_url=settings.KEYCLOAK_SERVER_URL.rstrip("/") + "/",
            realm_name=settings.REALM_NAME,
            client_id=settings.KEYCLOAK_CLIENT_ID,
            client_secret_key=settings.KEYCLOAK_CLIENT_SECRET,
            verify=True,
        )
        _admin = KeycloakAdmin(connection=connection)
    return _admin


async def get_keycloak_user(user_id: str) -> dict[str, Any]:
    """User representation from Keycloak, or ``{}`` when the admin client is
    unconfigured or the lookup fails.

    Enrichment reads must never break the caller: Keycloak being unreachable,
    the client lacking service-account access, or the user missing from the
    realm all degrade to "no extra data". Writes (update/delete) intentionally
    do NOT go through this — a failed write must surface, not desync silently.
    """
    if not settings.AUTH:
        return {}
    admin = await keycloak_admin()
    if admin is None:
        return {}
    try:
        # python-keycloak is synchronous (requests): off the event loop, so a
        # slow Keycloak does not stall every other request of the pod.
        return await asyncio.to_thread(admin.get_user, user_id) or {}
    except KeycloakGetError as e:
        if e.response_code == 404:
            logger.warning("keycloak user %s not found in realm", user_id)
        else:
            logger.warning("keycloak user lookup failed for %s", user_id, exc_info=True)
        return {}
    except KeycloakError:
        logger.warning("keycloak user lookup failed for %s", user_id, exc_info=True)
        return {}


# Writes still running (a reference keeps the task alive until it is done).
_locale_writes: set[asyncio.Task] = set()


async def set_user_locale(user_id: str, lang: str) -> bool:
    """Store GOAT's language for the user in Keycloak (attribute ``locale``), so
    its pages and emails (verify, password reset) follow what the user chose in
    GOAT. True when Keycloak has it.

    Best effort, like the other enrichment: no admin client, Keycloak down or a
    service account without manage-users only log a warning. The whole user is
    read and sent back with only the locale changed: with the declarative user
    profile, a field or attribute left out of the update is cleared (an update
    with only the attributes emptied the user's first and last name)."""
    if not settings.AUTH:
        return False
    admin = await keycloak_admin()
    if admin is None:
        return False

    def write() -> None:
        user = admin.get_user(user_id) or {}
        attributes = dict(user.get("attributes") or {})
        if not user or attributes.get("locale") == [lang]:
            return
        attributes["locale"] = [lang]
        admin.update_user(user_id=user_id, payload={**user, "attributes": attributes})

    try:
        await asyncio.to_thread(write)
        return True
    except Exception:  # a background write: log anything, never raise
        logger.warning("keycloak locale write failed for %s", user_id, exc_info=True)
        return False


def report_locale(user_id: str, lang: str) -> None:
    """``set_user_locale`` in the background: saving the setting never waits for
    Keycloak."""
    task = asyncio.get_running_loop().create_task(set_user_locale(user_id, lang))
    _locale_writes.add(task)
    task.add_done_callback(_locale_writes.discard)


async def create_invited_user(email: str) -> str | None:
    """Create a Keycloak account for an invited email that has none.

    Returns the new user's id, or ``None`` when nothing was created: the
    setting KEYCLOAK_PROVISION_INVITED_USERS or AUTH is off, the admin client
    is not configured, or the realm already has an account for the email.

    The account is enabled with the UPDATE_PASSWORD required action, so the
    first login asks for a password of the invitee's own. ``emailVerified``
    stays false: the address is proven only once the invitee follows a link
    sent to it. VERIFY_EMAIL is not required, because an invitee whose
    password an administrator sets by hand (no email delivery) could then
    never finish logging in.

    Lookup and create failures raise ``KeycloakError``: the caller must not
    promise an invitation the invitee can never accept.
    """
    if not (settings.AUTH and settings.KEYCLOAK_PROVISION_INVITED_USERS):
        return None
    admin = await keycloak_admin()
    if admin is None:
        logger.error(
            "KEYCLOAK_PROVISION_INVITED_USERS is on but the Keycloak admin client "
            "is not configured; no account created for the invitee"
        )
        return None
    # The email search is not guaranteed to be exact on every Keycloak
    # version; only the same address (case-insensitive) is an existing account.
    matches = admin.get_users({"email": email, "exact": True})
    if any((user.get("email") or "").lower() == email.lower() for user in matches):
        return None
    try:
        return admin.create_user(
            {
                "username": email,
                "email": email,
                "enabled": True,
                "emailVerified": False,
                "requiredActions": INVITED_USER_ACTIONS,
            }
        )
    except KeycloakPostError as e:
        # 409: an account with this username or email exists (for example
        # created by a concurrent invitation), so the invitee can log in.
        if e.response_code == 409:
            return None
        raise


async def send_account_setup_email(user_id: str, redirect_uri: str) -> bool:
    """Have Keycloak email the user a link to set their password.

    Returns ``False`` instead of raising when Keycloak cannot send it (no SMTP
    configured for the realm, a rejected redirect URI, ...): the account
    exists either way and an administrator can set the password in the
    Keycloak admin console.
    """
    admin = await keycloak_admin()
    if admin is None:
        return False
    try:
        admin.send_update_account(
            user_id=user_id,
            payload=INVITED_USER_ACTIONS,
            client_id=settings.KEYCLOAK_CLIENT_ID,
            lifespan=INVITED_USER_ACTIONS_LIFESPAN,
            redirect_uri=redirect_uri,
        )
    except KeycloakError:
        logger.warning(
            "keycloak could not send the account setup email to user %s",
            user_id,
            exc_info=True,
        )
        return False
    return True
