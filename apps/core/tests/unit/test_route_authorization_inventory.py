"""Every core API route is either authorized or deliberately anonymous.

Walks the real app's routes and fails when:
- a route has no dependency that verifies the caller's token, and is not one
  of the deliberately anonymous routes listed in ANONYMOUS;
- a route reads the caller with `get_user_id`, which takes `sub` from the
  token without checking its signature, but nothing on the route verifies
  that token;
- a route behind `auth_z` matches no seeded resource at all, which answers
  401 to every caller once auth is on.
"""

from collections.abc import Iterator

import pytest
from core.core.config import settings
from core.db.seed_roles import RESOURCES_PERMISSIONS
from core.main import app
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute

# Dependencies that verify the bearer token's signature when auth is on.
VERIFYING = {
    "auth_z",
    "user_token",
    "get_current_token_claims",
    "require_superuser",
    "auth",
}

# (method, pattern) -> why the route needs no token.
ANONYMOUS = {
    (
        "POST",
        "webhooks/odoo/entitlement",
    ): "billing pushes it with the shared ODOO_WEBHOOK_SECRET; the route checks it",
    (
        "POST",
        "webhooks/trial",
    ): "the trial_expiry task calls it with the shared ODOO_WEBHOOK_SECRET; the route checks it",
    ("GET", "project/{project_id}/public"): "the published, public view of a project",
    (
        "GET",
        "custom-domain-config",
    ): "the web app's middleware resolves a host before any login",
    (
        "GET",
        "custom-domain-lookup",
    ): "Caddy's on-demand TLS asks whether to issue a certificate",
}


def _routes() -> Iterator[tuple[str, str, APIRoute]]:
    for route in app.router.routes:
        contexts = (
            route.effective_route_contexts()
            if hasattr(route, "effective_route_contexts")
            else []
        )
        for context in contexts:
            api_route = context.original_route
            if not isinstance(api_route, APIRoute):
                continue
            if not context.path.startswith(f"{settings.API_V2_STR}/"):
                continue
            pattern = context.path[len(settings.API_V2_STR) + 1 :]
            for method in sorted(api_route.methods - {"HEAD", "OPTIONS"}):
                yield method, pattern, api_route


def _dependency_names(dependant: Dependant) -> set[str]:
    names: set[str] = set()
    for dependency in dependant.dependencies:
        names.add(getattr(dependency.call, "__name__", repr(dependency.call)))
        names |= _dependency_names(dependency)
    return names


def _matches_a_resource(method: str, pattern: str) -> bool:
    """`check_resource`'s lookup: the exact pattern, then any `<seeded>/…`."""
    seeded = [r["url_pattern"] for r in RESOURCES_PERMISSIONS if method in r["method"]]
    bare = pattern.rstrip("/")
    return bare in seeded or any(pattern.startswith(f"{p}/") for p in seeded)


ROUTES = sorted(
    (
        (method, pattern, _dependency_names(route.dependant))
        for method, pattern, route in _routes()
    ),
    key=lambda r: (r[1], r[0]),
)


@pytest.mark.unit
def test_the_walk_finds_the_api() -> None:
    assert len(ROUTES) > 100


@pytest.mark.unit
def test_every_route_verifies_the_token_or_is_deliberately_anonymous() -> None:
    unverified = [
        f"{method} {pattern}"
        for method, pattern, names in ROUTES
        if not names & VERIFYING and (method, pattern) not in ANONYMOUS
    ]
    assert unverified == [], "routes without token verification: " + ", ".join(
        unverified
    )


@pytest.mark.unit
def test_the_anonymous_list_has_no_stale_entries() -> None:
    present = {(method, pattern) for method, pattern, _ in ROUTES}
    assert set(ANONYMOUS) <= present, set(ANONYMOUS) - present


@pytest.mark.unit
def test_no_route_trusts_an_unverified_user_id() -> None:
    spoofable = [
        f"{method} {pattern}"
        for method, pattern, names in ROUTES
        if "get_user_id" in names and not names & VERIFYING
    ]
    assert spoofable == [], "get_user_id without verification: " + ", ".join(spoofable)


@pytest.mark.unit
def test_every_authorized_route_has_a_seeded_resource() -> None:
    unmatched = [
        f"{method} {pattern}"
        for method, pattern, names in ROUTES
        if "auth_z" in names and not _matches_a_resource(method, pattern)
    ]
    assert unmatched == [], (
        "auth_z routes no resource matches (401 for all): " + ", ".join(unmatched)
    )
