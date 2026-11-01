from typing import Generator
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from jose import jwt
from sqlalchemy.ext.asyncio import AsyncSession

from core.accounts import report_sign_up
from core.core.config import settings
from core.crud.crud_folder import folder as crud_folder
from core.db.session import session_manager
from core.schemas.folder import FolderCreate


async def get_db() -> Generator:  # type: ignore
    async with session_manager.session() as session:
        yield session


def default_user_claims() -> dict:
    """Synthetic JWT claims for the default identity (AUTH=False only)."""
    return {
        "sub": settings.DEFAULT_USER_ID,
        "email": settings.DEFAULT_USER_EMAIL,
        "given_name": settings.DEFAULT_USER_FIRSTNAME,
        "family_name": settings.DEFAULT_USER_LASTNAME,
        "realm_access": {"roles": ["superuser"]},
    }


def get_user_id(request: Request) -> UUID:
    """Get the user ID from the JWT token or the default identity if running without authentication."""
    # Check if the request has an Authorization header
    authorization = request.headers.get("Authorization")

    if authorization:
        # Split the Authorization header into the scheme and the token
        scheme, _, token = authorization.partition(" ")

        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid Authorization Scheme")
        if not token:
            raise HTTPException(status_code=401, detail="Missing Authorization Token")

        # Decode the JWT token and extract the user_id
        result = jwt.get_unverified_claims(token)["sub"]
    else:
        # No Authorization header: act as the default identity.
        result = settings.DEFAULT_USER_ID

    return UUID(result)


def get_current_token_claims(request: Request) -> dict:
    """Return the JWT claims with the signature verified (when AUTH is enabled).

    Falls back to the sample token only when AUTH is disabled (local/dev). Unlike
    ``get_user_id`` this does NOT use unverified claims, so it is safe to base
    user provisioning on it.
    """
    from jose import JOSEError, jwt

    from core.deps.auth import decode_token

    authorization = request.headers.get("Authorization")

    if not settings.AUTH:
        # Dev mode: no verification. Use the provided bearer token or the
        # default identity.
        if authorization:
            return jwt.get_unverified_claims(authorization.partition(" ")[2])
        return default_user_claims()

    # AUTH enabled: a bearer token is required and its signature is verified.
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization Token")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")
    try:
        return decode_token(token)
    except JOSEError as e:
        raise HTTPException(status_code=401, detail=str(e))


async def ensure_home_folder(
    async_session: AsyncSession = Depends(get_db),
    claims: dict = Depends(get_current_token_claims),
) -> None:
    """Lazily provision the user (from the verified token) and a home folder.

    For users authenticating via an external provider (Keycloak) who don't have
    local data yet. The user row is upserted straight from the token claims, so
    it works without a Keycloak admin client.
    """
    from sqlalchemy.exc import IntegrityError

    from core.crud.crud_space import space as crud_space
    from core.crud.crud_user import user as crud_user

    user = await crud_user.upsert_from_token(token=claims, db_session=async_session)
    assert user.id is not None
    # SaaS: a verified user the accounts provider does not know yet is reported.
    report_sign_up(user, claims)

    existing = await crud_folder.get_by_multi_keys(
        async_session, keys={"user_id": user.id, "name": "home"}
    )
    if not existing:
        try:
            space_id = (await crud_space.ensure_personal(async_session, user.id)).id
            folder = FolderCreate(name="home", user_id=user.id, space_id=space_id)
            await crud_folder.create(async_session, obj_in=folder)
        except IntegrityError:
            # Another request already created the folder (race condition)
            await async_session.rollback()
