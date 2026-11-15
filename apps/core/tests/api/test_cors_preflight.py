import pytest
from core.core.config import settings


@pytest.mark.asyncio
async def test_a_browser_may_keep_the_preflight_for_two_hours(client):
    """Every API call of the web carries a bearer token, so a cross-origin one
    is preflighted; Chromium caps how long it keeps that answer at two hours."""
    r = await client.options(
        f"{settings.API_V2_STR}/credits/balance",
        headers={
            "Origin": "http://example.test",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["access-control-max-age"] == "7200"
