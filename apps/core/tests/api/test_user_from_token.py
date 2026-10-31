"""The newsletter consent from the sign-up reaches GOAT with the token."""

import uuid

import pytest
from core.crud.crud_user import user as crud_user


def _token(**claims: str) -> dict:
    sub = str(uuid.uuid4())
    return {
        "sub": sub,
        "email": f"{sub[:8]}@example.org",
        "given_name": "A",
        "family_name": "B",
        **claims,
    }


@pytest.mark.asyncio
async def test_newsletter_consent_from_the_sign_up(db_session):
    user = await crud_user.upsert_from_token(
        token=_token(newsletter="1760430000000"), db_session=db_session
    )
    assert user.newsletter_subscribe is True


@pytest.mark.asyncio
async def test_no_consent_without_the_claim(db_session):
    user = await crud_user.upsert_from_token(token=_token(), db_session=db_session)
    assert user.newsletter_subscribe is False


@pytest.mark.asyncio
async def test_consent_reaches_a_user_created_without_the_claim(db_session):
    from core.db.models.user import User

    token = _token(newsletter="on")
    db_session.add(
        User(id=token["sub"], email=token["email"], firstname="A", lastname="B")
    )
    await db_session.commit()
    user = await crud_user.upsert_from_token(token=token, db_session=db_session)
    assert user.newsletter_subscribe is True
