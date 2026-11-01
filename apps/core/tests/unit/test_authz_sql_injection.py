import types
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from core.core.config import settings
from core.deps.auth import _validate_authorization


class _Result:
    def scalars(self):
        m = MagicMock()
        m.all.return_value = [True]
        return m


@pytest.mark.asyncio
async def test_authorization_call_is_parameterized(monkeypatch):
    """The authorization() call must bind user input as parameters, never
    f-string-interpolate it into the SQL (SQL-injection regression guard)."""
    monkeypatch.setattr(settings, "AUTH", True)

    session = MagicMock()
    session.execute = AsyncMock(return_value=_Result())

    malicious = "x'); DROP TABLE customer.user; --"
    request = MagicMock()
    request.scope = {
        "path": f"{settings.API_V2_STR}/organizations/{malicious}",
        "route": types.SimpleNamespace(
            path=f"{settings.API_V2_STR}/organizations/{{organization_id}}"
        ),
        "method": "GET",
    }

    ok = await _validate_authorization(request, {"sub": malicious}, session)
    assert ok is True

    session.execute.assert_awaited_once()
    args = session.execute.await_args.args
    sql_text = str(args[0])
    params = args[1]
    # the injection payload is NOT interpolated into the SQL ...
    assert malicious not in sql_text
    assert ":user_id" in sql_text
    # ... it travels as a bound parameter instead
    assert params["user_id"] == malicious


@pytest.mark.asyncio
async def test_uuid_bind_cast_roundtrips(db_session):
    """The :user_id::uuid bound-param + cast must execute through the real
    driver exactly as the authorization() call now uses it."""
    from sqlalchemy import text

    uid = "744e4fd1-685c-495c-8b02-efebce875359"
    result = await db_session.execute(
        text("SELECT CAST(:user_id AS uuid) AS u"), {"user_id": uid}
    )
    assert str(result.scalar_one()) == uid


# A resource type is formatted into SQL as a table name: one outside the
# known types must never reach the database.
UNKNOWN_TYPE = "layer WHERE false; DROP TABLE customer.user; --"


def _session_without_sql() -> MagicMock:
    session = MagicMock()
    session.execute = AsyncMock(side_effect=AssertionError("no SQL may run"))
    session.get = AsyncMock(side_effect=AssertionError("no SQL may run"))
    return session


@pytest.mark.asyncio
async def test_require_refuses_an_unknown_resource_type_before_any_sql():
    from core.core import authz

    session = _session_without_sql()

    with pytest.raises(ValueError):
        await authz.require(session, UNKNOWN_TYPE, uuid4(), uuid4(), "read")
    session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_set_restricted_refuses_an_unknown_resource_type_before_any_sql():
    from core.crud.crud_content import content

    session = _session_without_sql()

    with pytest.raises(ValueError):
        await content.set_restricted(
            session,
            user_id=uuid4(),
            resource_type=UNKNOWN_TYPE,  # type: ignore[arg-type]
            resource_id=uuid4(),
            restricted=True,
        )
    session.execute.assert_not_awaited()
    session.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_the_restricted_route_answers_422_for_an_unknown_resource_type(client):
    response = await client.patch(
        f"{settings.API_V2_STR}/content/layer;DROP TABLE x/{uuid4()}/restricted",
        json={"restricted": True},
    )

    assert response.status_code == 422, response.text
