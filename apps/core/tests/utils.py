import base64
import json
from uuid import UUID, uuid4

from core.core.config import settings
from core.db.models.organization import Organization
from core.db.models.role import Role
from core.db.models.user import User
from core.db.seed_roles import seed_roles
from httpx import AsyncClient
from sqlalchemy import select, text


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


async def org_with_default_user(db_session, **overrides) -> tuple[Organization, User]:
    """A new organization (make_organization(**overrides)) with the default
    user, the identity of every request with AUTH=False, as its member."""
    org = make_organization(**overrides)
    db_session.add(org)
    await db_session.commit()
    await db_session.refresh(org)
    user = await db_session.get(User, settings.DEFAULT_USER_ID)
    if user is None:
        user = User(
            id=settings.DEFAULT_USER_ID,
            email="r@t.local",
            firstname="Rep",
            lastname="Orter",
            organization_id=org.id,
        )
        db_session.add(user)
    else:
        user.organization_id = org.id
        user.firstname = "Rep"
        user.lastname = "Orter"
    await db_session.commit()
    return org, user


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


def as_user(user_id) -> dict[str, str]:
    """Headers acting as `user_id`. With AUTH off core reads the token's
    claims without checking its signature, so an unsigned token will do."""

    def segment(payload: dict) -> str:
        raw = json.dumps(payload).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    token = (
        f"{segment({'alg': 'none', 'typ': 'JWT'})}.{segment({'sub': str(user_id)})}.sig"
    )
    return {"Authorization": f"Bearer {token}"}


async def seeded_roles(db_session) -> dict[str, UUID]:
    """The roles, permissions and resources of a deployment (idempotent; it
    commits), as role name to id."""
    await seed_roles(db_session)
    rows = (await db_session.execute(select(Role.name, Role.id))).all()
    return {name: role_id for name, role_id in rows}


async def give_org_role(db_session, user_id, role_id) -> None:
    """Give a user an organization role (`user_role`) and commit."""
    await db_session.execute(
        text(
            f"INSERT INTO {settings.SCHEMA}.user_role (user_id, role_id) VALUES (:u, :r)"
        ),
        {"u": user_id, "r": role_id},
    )
    await db_session.commit()
