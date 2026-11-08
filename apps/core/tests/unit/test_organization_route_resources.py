"""Every organization-scoped route resolves to a seeded authz resource.

``auth_z`` looks the request up by the pattern ``route_pattern`` rebuilds,
and a pattern no seeded resource matches answers 401 for everyone. A router
mounted under a prefix that itself holds a placeholder
(``/organizations/{organization_id}/domains``) produced such a pattern: the
prefix is copied from the concrete request path, so the organization id
ended up in the pattern as a literal value.
"""

from uuid import UUID

import pytest
from core.core.config import settings
from core.db.seed_roles import RESOURCES_PERMISSIONS
from core.deps.auth import auth_z, clean_path, route_pattern
from core.endpoints.v2.api import router as api_router
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

# Fixed ids: parallel test workers must collect identical test names.
ORG = UUID("6f0a2c3e-1b4d-4e5f-8a9b-0c1d2e3f4a5b")
ITEM = UUID("7e1b3d4f-2c5e-4f6a-9b0c-1d2e3f4a5b6c")
REQUESTS = [
    ("GET", f"organizations/{ORG}/domains/"),
    ("POST", f"organizations/{ORG}/domains/"),
    ("GET", f"organizations/{ORG}/domains/{ITEM}"),
    ("DELETE", f"organizations/{ORG}/domains/{ITEM}"),
    ("POST", f"organizations/{ORG}/domains/{ITEM}/recheck"),
    ("GET", f"organizations/{ORG}/analytics/"),
    ("POST", f"organizations/{ORG}/analytics/"),
    ("PUT", f"organizations/{ORG}/analytics/{ITEM}"),
    ("DELETE", f"organizations/{ORG}/analytics/{ITEM}"),
    ("GET", f"organizations/{ORG}/analytics/dashboards"),
    ("PUT", f"organizations/{ORG}/analytics/{ITEM}/dashboards"),
    ("PATCH", f"organizations/{ORG}/profile"),
    ("DELETE", f"organizations/{ORG}"),
    ("POST", f"organizations/{ORG}/invitations/{ITEM}/resend"),
]


def _seeded_match(pattern: str, method: str) -> bool:
    """The lookup `check_resource` does: exact pattern, then `<pattern>/…`."""
    candidates = [r for r in RESOURCES_PERMISSIONS if method in r["method"]]
    if any(r["url_pattern"] == pattern for r in candidates):
        return True
    return any(pattern.startswith(f"{r['url_pattern']}/") for r in candidates)


@pytest.fixture(scope="module")
def captured_patterns() -> dict[tuple[str, str], str]:
    captured: dict[tuple[str, str], str] = {}

    def capture(request: Request) -> None:
        key = (request.method, clean_path(request.scope["path"]))
        captured[key] = clean_path(route_pattern(request))
        # Stop before the handler: only the pattern auth_z would see matters.
        raise HTTPException(status_code=418)

    app = FastAPI()
    app.include_router(api_router, prefix=settings.API_V2_STR)
    app.dependency_overrides[auth_z] = capture
    client = TestClient(app)
    for method, path in REQUESTS:
        response = client.request(method, f"{settings.API_V2_STR}/{path}", json={})
        assert response.status_code == 418, f"{method} {path} did not reach auth_z"
    return captured


@pytest.mark.unit
@pytest.mark.parametrize(("method", "path"), REQUESTS)
def test_organization_route_pattern_has_a_seeded_resource(
    captured_patterns: dict[tuple[str, str], str], method: str, path: str
) -> None:
    pattern = captured_patterns[(method, path)]
    assert str(ORG) not in pattern, f"the organization id leaked into {pattern!r}"
    assert _seeded_match(pattern, method), f"no seeded resource for {method} {pattern}"
