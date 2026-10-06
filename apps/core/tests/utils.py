from uuid import uuid4

from core.core.config import settings
from core.db.models.organization import Organization
from httpx import AsyncClient


async def get_with_wrong_id(client: AsyncClient, item: str):
    """Get item with wrong ID."""

    id = uuid4()
    response = await client.get(
        f"{settings.API_V2_STR}/{item}/{str(id)}",
    )
    assert response.status_code == 404


def make_organization(**overrides) -> Organization:
    """Build an Organization with all NOT NULL columns filled with test defaults."""
    values = {
        "name": f"test-org-{uuid4().hex[:6]}",
        "avatar": "https://assets.plan4better.de/img/no-org-thumbnail.png",
        "total_storage": 1024,
        "total_credits": 1000,
        "total_projects": 100,
        "total_editors": 10,
        "total_viewers": 10,
        "on_trial": False,
        "type": "private",
        "contact_user_id": uuid4(),
        "region": "EU",
        "suspended": False,
    }
    values.update(overrides)
    return Organization(**values)


#: Canonical target the custom-domain tests run with.
TEST_CNAME_TARGET = "cname.goat.plan4better.de"


def fake_dns_resolve(cname=(), base_a=(), canonical_a=("203.0.113.10",)):
    """Fake for ``core.services.domain_reconciliation._resolve(domain, rdtype)``.

    CNAME lookups return ``cname``. A lookups return ``canonical_a`` for the
    canonical target ``TEST_CNAME_TARGET`` (so the apex fallback can proceed)
    and ``base_a`` for the customer's own domain.
    """

    async def resolve(domain: str, rdtype: str) -> list[str]:
        if rdtype == "CNAME":
            return list(cname)
        if domain == TEST_CNAME_TARGET:
            return list(canonical_a)
        return list(base_a)

    return resolve
