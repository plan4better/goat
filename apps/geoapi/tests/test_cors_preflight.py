"""The CORS preflight answer a browser may cache."""

from fastapi.testclient import TestClient


def test_a_browser_may_keep_the_preflight_for_two_hours(
    test_client: TestClient,
) -> None:
    # Chromium caps how long it keeps a preflight answer at two hours.
    r = test_client.options(
        "/collections",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-max-age"] == "7200"
