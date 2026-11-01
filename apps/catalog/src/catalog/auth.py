"""Bearer-JWT auth dependency for the ``/stac`` router.

Mirrors geoapi's Keycloak-token validation
(``apps/geoapi/src/geoapi/deps/auth.py``) via the same shared
``goatlib.auth.KeycloakAuth``, gated by ``CatalogSettings.auth`` -- the
repo-wide ``AUTH`` env var (see ``catalog.config``). The catalog API returns
no per-user data (api spec §1), so this dependency only ever needs to answer
"is there a valid token", never who the caller is.

``validate_token`` is the seam tests monkeypatch to exercise the
401-without-token path under ``AUTH=True`` without touching a real Keycloak
server (constructing ``KeycloakAuth`` with ``verify_signature=True`` fetches
its public key over the network on first use).
"""

from typing import Any

from fastapi import Depends, Request
from fastapi.security import OAuth2PasswordBearer
from goatlib.auth import JOSEError, KeycloakAuth

from catalog.config import CatalogSettings
from catalog.errors import ApiError

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token", auto_error=False)

_keycloak_auth_cache: dict[tuple[str, str, str], KeycloakAuth] = {}


def _get_keycloak_auth(settings: CatalogSettings) -> KeycloakAuth:
    key = (
        settings.keycloak_server_url,
        settings.realm_name,
        settings.auth_allowed_clients,
    )
    auth = _keycloak_auth_cache.get(key)
    if auth is None:
        auth = KeycloakAuth(
            keycloak_url=settings.keycloak_server_url,
            realm=settings.realm_name,
            verify_signature=True,
            allowed_clients=settings.auth_allowed_clients,
        )
        _keycloak_auth_cache[key] = auth
    return auth


def validate_token(settings: CatalogSettings, token: str) -> dict[str, Any]:
    """Decode + verify a bearer token; raises ``JOSEError`` if invalid."""
    payload: dict[str, Any] = _get_keycloak_auth(settings).decode_token(token)
    return payload


def _extract_bearer_token(request: Request, token: str | None) -> str | None:
    if token:
        return token
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header[7:]
    return None


async def require_auth(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
) -> None:
    """Router-level auth gate: a no-op when ``AUTH=False``.

    When ``AUTH=True``, requires a Bearer token that validates against
    Keycloak; anything else is a 401.
    """
    settings: CatalogSettings = request.app.state.settings
    if not settings.auth:
        return

    bearer = _extract_bearer_token(request, token)
    if not bearer:
        raise ApiError(
            401, "Missing authorization token", headers={"WWW-Authenticate": "Bearer"}
        )

    try:
        validate_token(settings, bearer)
    except JOSEError as exc:
        raise ApiError(
            401,
            f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def optional_auth(request: Request) -> None:
    """Read-path gate for the public catalog: anonymous is allowed, a *bad*
    token is not.

    The catalog's metadata is public (design S1/S14) -- the GOAT UI's catalog
    page is served on a public route and embedded off-site, so its visitors
    carry no token and every read must work without one. This deliberately
    does **not** simply skip validation: a request that presents a token is
    making a claim about who it is, and honouring a malformed or expired one
    by silently degrading to anonymous would turn "your token expired" into
    "you quietly see less", and would let a broken client believe it is
    authenticated. So: no credentials -> anonymous; valid credentials -> fine;
    invalid credentials -> 401.

    Nothing here grants anything *extra* to an authenticated caller yet; the
    validation exists so that when org-restricted entries and signed asset
    access arrive (design §10), identity is already trustworthy at this seam.

    Reads the ``Authorization`` header directly instead of depending on
    ``oauth2_scheme``: that dependency would register an OpenAPI *security
    requirement* on every route using it, so Swagger would draw a padlock on
    all 16 public read endpoints and tell readers they need credentials they
    do not need. The header parsing is identical either way -- only the
    generated documentation differs.
    """
    settings: CatalogSettings = request.app.state.settings
    if not settings.auth:
        return

    bearer = _extract_bearer_token(request, None)
    if not bearer:
        return  # anonymous read -- the public case

    try:
        validate_token(settings, bearer)
    except JOSEError as exc:
        raise ApiError(
            401,
            f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
