"""Read authorization for layer-serving endpoints.

`require_layer_read` runs as a route dependency ahead of every layer-serving
endpoint except `get_features`. It is flagged behind
`Settings.ENFORCE_READ_AUTHZ` (default False = shadow mode): a denied read
is only logged, never blocked, until the flag is flipped on after the
shadow-mode counter is quiet. It never bypasses the check.

`require_layer_read_unless_temp` is the one exception, attached only to
`get_features`: it bypasses the check for that route's own `?temp=true`
branch (temp layers are per-user scratch parquet files, never rows in
`customer.layer`). `?temp=true` must have no effect on any other route —
covered here by a router-level negative test against the tile route.

Both share a short in-process TTL cache (so one map pan costs one Postgres
round trip per layer/user, not one per tile).
"""

import logging
from typing import Generator
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from geoapi.deps import authz
from geoapi.deps.authz import require_layer_read, require_layer_read_unless_temp

USER = UUID("22222222-2222-2222-2222-222222222222")
COLLECTION_ID = "abc123def456789012345678901234ab"


def _request() -> Request:
    """A request for the dependency to leave its verdict on."""
    return Request({"type": "http", "headers": []})


@pytest.fixture(autouse=True)
def _clear_read_authz_cache() -> Generator[None, None, None]:
    """The cache is module-level state; tests must not leak into each other."""
    authz._read_authz_cache.clear()
    yield
    authz._read_authz_cache.clear()


async def test_denied_when_enforced() -> None:
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(return_value=False),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        with pytest.raises(HTTPException) as e:
            await require_layer_read(COLLECTION_ID, USER, request=_request())
        assert e.value.status_code == 403


async def test_shadow_mode_only_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="geoapi.read_authz")
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(return_value=False),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", False),
    ):
        await require_layer_read(COLLECTION_ID, USER, request=_request())  # no raise
    assert "would_deny" in caplog.text


async def test_allowed_passes_silently() -> None:
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(return_value=True),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        await require_layer_read(COLLECTION_ID, None, request=_request())


async def test_cache_hit_avoids_a_second_service_call() -> None:
    mock_check = AsyncMock(return_value=True)
    with patch("geoapi.deps.authz.layer_service.user_can_read_layer", mock_check):
        await require_layer_read(COLLECTION_ID, USER, request=_request())
        await require_layer_read(COLLECTION_ID, USER, request=_request())
    mock_check.assert_awaited_once()


async def test_cache_expires_after_ttl() -> None:
    mock_check = AsyncMock(return_value=True)
    fake_now = [1000.0]
    with (
        patch("geoapi.deps.authz.layer_service.user_can_read_layer", mock_check),
        patch("geoapi.deps.authz._now", side_effect=lambda: fake_now[0]),
    ):
        await require_layer_read(COLLECTION_ID, USER, request=_request())
        fake_now[0] += authz.READ_AUTHZ_CACHE_TTL_SECONDS + 1
        await require_layer_read(COLLECTION_ID, USER, request=_request())
    assert mock_check.await_count == 2


async def test_require_layer_read_never_bypasses_for_temp() -> None:
    """`require_layer_read` (the six non-get_features routes) has no temp
    parameter at all: it always checks, regardless of any `temp` query."""
    mock_check = AsyncMock(return_value=False)
    with (
        patch("geoapi.deps.authz.layer_service.user_can_read_layer", mock_check),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        with pytest.raises(HTTPException) as e:
            await require_layer_read(COLLECTION_ID, USER, request=_request())
        assert e.value.status_code == 403
    mock_check.assert_awaited_once()


async def test_require_layer_read_unless_temp_bypasses_when_temp() -> None:
    """Temp layers are per-user scratch results, not shareable content."""
    mock_check = AsyncMock(return_value=False)
    with (
        patch("geoapi.deps.authz.layer_service.user_can_read_layer", mock_check),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        await require_layer_read_unless_temp(COLLECTION_ID, True, USER)  # no raise
    mock_check.assert_not_awaited()


async def test_require_layer_read_unless_temp_checks_when_not_temp() -> None:
    mock_check = AsyncMock(return_value=False)
    with (
        patch("geoapi.deps.authz.layer_service.user_can_read_layer", mock_check),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        with pytest.raises(HTTPException) as e:
            await require_layer_read_unless_temp(COLLECTION_ID, False, USER)
        assert e.value.status_code == 403
    mock_check.assert_awaited_once()


async def test_service_error_in_shadow_mode_passes_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """I4: a service-call error must not 500 the request. In shadow mode it
    is treated as allowed, and logged as `read_authz.error` (not
    `would_deny` — this is a backend failure, not a policy denial)."""
    caplog.set_level(logging.ERROR, logger="geoapi.read_authz")
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(side_effect=RuntimeError("customer.can missing")),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", False),
    ):
        await require_layer_read(COLLECTION_ID, USER, request=_request())  # no raise
    assert "read_authz.error" in caplog.text


async def test_service_error_when_enforced_denies() -> None:
    """I4: fail closed — an error while enforcement is on must 403, not 500
    and not silently allow."""
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(side_effect=RuntimeError("customer.can missing")),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        with pytest.raises(HTTPException) as e:
            await require_layer_read(COLLECTION_ID, USER, request=_request())
        assert e.value.status_code == 403


async def test_service_error_verdict_is_never_cached() -> None:
    """I4: an error verdict must not be cached — the very next call must hit
    the service again, not replay a cached error-derived allow/deny."""
    mock_check = AsyncMock(
        side_effect=[RuntimeError("transient"), True],
    )
    with (
        patch("geoapi.deps.authz.layer_service.user_can_read_layer", mock_check),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", False),
    ):
        await require_layer_read(
            COLLECTION_ID, USER, request=_request()
        )  # errors, shadow-allows
        await require_layer_read(
            COLLECTION_ID, USER, request=_request()
        )  # must call again, not use a cached verdict
    assert mock_check.await_count == 2


def test_temp_query_param_does_not_bypass_the_tile_route(
    test_client: TestClient,
) -> None:
    """Regression: `?temp=true` must not defeat the gate on routes other than
    `get_features` — `get_tile` has no temp branch of its own, so a denied
    read must still 403 even when the request carries `?temp=true`."""
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(return_value=False),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", True),
    ):
        response = test_client.get(
            f"/collections/{COLLECTION_ID}/tiles/WebMercatorQuad/10/512/256"
            "?temp=true"
        )
    assert response.status_code == 403


@pytest.mark.parametrize(
    ("verdict", "anyone"),
    [(AsyncMock(return_value=True), True), (AsyncMock(return_value=False), False)],
)
async def test_the_verdict_without_a_sign_in_is_left_on_the_request(
    verdict: AsyncMock, anyone: bool
) -> None:
    """Without a sign-in the rule's verdict is whether anyone may read the
    layer; the tile routes read it from the request (shadow mode serves both)."""
    request = _request()
    with (
        patch("geoapi.deps.authz.layer_service.user_can_read_layer", verdict),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", False),
    ):
        await require_layer_read(COLLECTION_ID, None, request=request)
    assert authz.read_by_anyone(request) is anyone


async def test_a_signed_in_verdict_says_nothing_about_anyone() -> None:
    request = _request()
    with patch(
        "geoapi.deps.authz.layer_service.user_can_read_layer",
        AsyncMock(return_value=True),
    ):
        await require_layer_read(COLLECTION_ID, USER, request=request)
    assert authz.read_by_anyone(request) is False


async def test_a_verdict_not_reached_is_not_anyone() -> None:
    """A rule that could not be evaluated (shadow mode serves the read) and a
    route without the check both leave the tile to the shorter cache."""
    request = _request()
    with (
        patch(
            "geoapi.deps.authz.layer_service.user_can_read_layer",
            AsyncMock(side_effect=RuntimeError("down")),
        ),
        patch("geoapi.deps.authz.settings.ENFORCE_READ_AUTHZ", False),
    ):
        await require_layer_read(COLLECTION_ID, None, request=request)
    assert authz.read_by_anyone(request) is False
    assert authz.read_by_anyone(_request()) is False


def test_without_sign_ins_anyone_may_read() -> None:
    """With `AUTH` off every reader is the one local user: nothing is private."""
    with patch("geoapi.deps.authz.settings.AUTH", False):
        assert authz.read_by_anyone(_request()) is True
