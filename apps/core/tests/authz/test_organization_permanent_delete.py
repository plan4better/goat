"""`DELETE /organizations/{id}/permanent`: a superuser removes an organization
that only ever held its creator.

Someone who signs in before their invitation exists sets up an organization
of their own, and from then on cannot be invited: a user belongs to one
organization. Deleting an organization through the regular route only
suspends it. This route removes the organization for real, but only when it
has at most one member and nothing in it: no content in its space or in the
member's personal space (trash included), no teams, no pending invitations,
no custom domains and no analytics settings. The member keeps their account
and personal space, loses their organization roles, and can then be invited.
An organization whose last member is gone can be removed the same way.
Everything happens in one transaction, so a failure part way changes nothing.
"""

from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.crud.crud_space import space as crud_space
from core.db.models._link_model import ResourceGrant
from core.db.models.assistant import (
    AssistantConnection,
    AssistantOrganizationSettings,
)
from core.db.models.bundle import Bundle
from core.db.models.folder import Folder
from core.db.models.invitation import Invitation, InvitationStatusEnum, InvitationType
from core.db.models.layer import Layer
from core.db.models.organization import Organization
from core.db.models.organization_analytics import OrganizationAnalytics
from core.db.models.organization_domain import OrganizationDomain
from core.db.models.project import Project
from core.db.models.team import Team
from core.db.models.template import Template, TemplatePayloadKind
from core.db.models.user import User
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.authz.route_world import API, give_org_role, sweep_client

S = settings.SCHEMA


@pytest.fixture(autouse=True)
def no_billing(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Creating an organization starts a trial when billing is on."""
    monkeypatch.setattr(settings, "BILLING_ENABLED", False)
    yield


@dataclass
class Lonely:
    """An organization whose only member is the one who set it up, with the
    folders GOAT creates on its own: the root of the organization space and
    the member's personal home folder."""

    organization_id: UUID
    member_id: UUID
    organization_space_id: UUID
    organization_root_id: UUID
    personal_space_id: UUID
    personal_home_id: UUID


async def _make_member(
    db: AsyncSession, make_user: Callable[..., Awaitable[User]], org_id: UUID | None
) -> User:
    """A user whose stored email is the one their test token carries, so the
    invitation routes find them by it."""
    user = await make_user(org_id)
    await db.execute(
        text(f"UPDATE {S}.user SET email = :e WHERE id = :id"),
        {"e": f"{str(user.id)[:8]}@goat.test", "id": user.id},
    )
    return user


async def _personal_home(db: AsyncSession, user_id: UUID) -> tuple[UUID, UUID]:
    space_id = (await crud_space.ensure_personal(db, user_id)).id
    assert space_id is not None
    home = Folder(id=uuid4(), user_id=user_id, space_id=space_id, name="home")
    db.add(home)
    await db.flush()
    assert home.id is not None
    return space_id, home.id


@pytest.fixture
async def lonely(
    db_session: AsyncSession,
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> Lonely:
    org = await make_org()
    assert org.id is not None
    member = await _make_member(db_session, make_user, org.id)
    await give_org_role(db_session, member.id, roles["organization-owner"])
    org_space = await crud_space.ensure_organization(db_session, org.id)
    assert org_space.id is not None
    org_root = await crud_space.ensure_root_folder(db_session, org_space.id)
    personal_space_id, personal_home_id = await _personal_home(db_session, member.id)
    await db_session.commit()
    return Lonely(
        organization_id=org.id,
        member_id=member.id,
        organization_space_id=org_space.id,
        organization_root_id=org_root,
        personal_space_id=personal_space_id,
        personal_home_id=personal_home_id,
    )


async def _scalar(db: AsyncSession, sql: str, **params: object) -> object:
    db.expire_all()
    return (await db.execute(text(sql), params)).scalar_one_or_none()


async def _roles_of(db: AsyncSession, user_id: UUID) -> set[str]:
    rows = await db.execute(
        text(
            f"SELECT r.name FROM {S}.user_role ur JOIN {S}.role r ON r.id = ur.role_id "
            "WHERE ur.user_id = :u"
        ),
        {"u": user_id},
    )
    return {row[0] for row in rows}


async def _organization_exists(db: AsyncSession, org_id: UUID) -> bool:
    return bool(
        await _scalar(
            db, f"SELECT count(*) FROM {S}.organization WHERE id = :o", o=org_id
        )
    )


async def _organization_of(db: AsyncSession, user_id: UUID) -> object:
    return await _scalar(
        db, f"SELECT organization_id FROM {S}.user WHERE id = :u", u=user_id
    )


async def _assert_untouched(db: AsyncSession, world: Lonely) -> None:
    assert await _organization_exists(db, world.organization_id)
    assert await _organization_of(db, world.member_id) == world.organization_id
    assert await _roles_of(db, world.member_id) == {"organization-owner"}
    assert await _scalar(
        db,
        f"SELECT count(*) FROM {S}.folder WHERE id = :f",
        f=world.organization_root_id,
    )


def _delete(org_id: UUID, headers: dict[str, str]):  # noqa: ANN202
    return sweep_client().delete(
        f"{API}/organizations/{org_id}/permanent", headers=headers
    )


async def _superuser(
    db: AsyncSession,
    make_user: Callable[..., Awaitable[User]],
    auth_on: Callable[..., dict[str, str]],
) -> dict[str, str]:
    """Staff: a superuser who is not a member of the organization."""
    staff = await make_user(None)
    await db.commit()
    return auth_on(staff.id, roles=["superuser"])


@pytest.mark.asyncio
async def test_a_mistaken_organization_goes_and_its_creator_can_be_invited(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    roles: dict[str, UUID],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    # Someone signs in and sets up an organization of their own...
    newcomer_id = (await _make_member(db_session, make_user, None)).id
    personal_space_id, personal_home_id = await _personal_home(db_session, newcomer_id)
    inviting_org_id = (await make_org()).id
    inviter_id = (await make_user(inviting_org_id)).id
    await give_org_role(db_session, inviter_id, roles["organization-owner"])
    await db_session.commit()
    created = await sweep_client().post(
        f"{API}/organizations",
        headers=auth_on(newcomer_id),
        json={
            "name": "By mistake",
            "department": "Planning",
            "industry": "urban_planning",
            "location": "DE",
            "type": "government",
            "use_case": "site_analysis_and_design_decision_support",
            "region": "EU",
            "phone_number": "+490000000000",
        },
    )
    assert created.status_code == 200, created.text
    own_org_id = UUID(created.json()["id"])
    # ...so the organization they belong to cannot invite them.
    invitation_body = {
        "user_email": f"{str(newcomer_id)[:8]}@goat.test",
        "role": "organization-editor",
    }
    refused = await sweep_client().post(
        f"{API}/organizations/{inviting_org_id}/invitations",
        headers=auth_on(inviter_id),
        json=invitation_body,
    )
    assert refused.status_code == 400, refused.text

    deleted = await _delete(
        own_org_id, await _superuser(db_session, make_user, auth_on)
    )

    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["id"] == str(own_org_id)
    assert deleted.json()["user_id"] == str(newcomer_id)
    assert not await _organization_exists(db_session, own_org_id)
    assert not await _scalar(
        db_session,
        f"SELECT count(*) FROM {S}.space WHERE organization_id = :o",
        o=own_org_id,
    )
    # The account stays, without an organization or an organization role.
    assert await _scalar(
        db_session, f"SELECT count(*) FROM {S}.user WHERE id = :u", u=newcomer_id
    )
    assert await _organization_of(db_session, newcomer_id) is None
    assert await _roles_of(db_session, newcomer_id) == set()
    assert await _scalar(
        db_session,
        f"SELECT count(*) FROM {S}.folder WHERE id = :f AND space_id = :s",
        f=personal_home_id,
        s=personal_space_id,
    )

    invited = await sweep_client().post(
        f"{API}/organizations/{inviting_org_id}/invitations",
        headers=auth_on(inviter_id),
        json=invitation_body,
    )
    assert invited.status_code == 200, invited.text
    accepted = await sweep_client().patch(
        f"{API}/users/invitations/{invited.json()['id']}",
        headers=auth_on(newcomer_id),
    )
    assert accepted.status_code == 204, accepted.text
    assert await _organization_of(db_session, newcomer_id) == inviting_org_id
    assert await _roles_of(db_session, newcomer_id) == {"organization-editor"}


@pytest.mark.asyncio
async def test_what_goat_creates_on_its_own_does_not_count_as_content(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    lonely: Lonely,
) -> None:
    # A grant names its grantee without a foreign key, so nothing else
    # removes one made to the organization.
    grant = ResourceGrant(
        resource_type="project",
        resource_id=uuid4(),
        grantee_type="organization",
        grantee_id=lonely.organization_id,
        role_id=roles["project-viewer"],
    )
    db_session.add(grant)
    await db_session.commit()

    deleted = await _delete(
        lonely.organization_id, await _superuser(db_session, make_user, auth_on)
    )

    assert deleted.status_code == 200, deleted.text
    assert not await _scalar(
        db_session,
        f"SELECT count(*) FROM {S}.resource_grant WHERE grantee_id = :o",
        o=lonely.organization_id,
    )
    assert not await _organization_exists(db_session, lonely.organization_id)
    assert not await _scalar(
        db_session,
        f"SELECT count(*) FROM {S}.folder WHERE id = :f",
        f=lonely.organization_root_id,
    )
    assert await _organization_of(db_session, lonely.member_id) is None
    assert await _scalar(
        db_session,
        f"SELECT count(*) FROM {S}.folder WHERE id = :f",
        f=lonely.personal_home_id,
    )


@pytest.mark.asyncio
async def test_grants_on_the_folders_that_go_are_removed_with_them(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    roles: dict[str, UUID],
    make_user: Callable[..., Awaitable[User]],
    lonely: Lonely,
) -> None:
    """A grant names its resource without a foreign key, so one on the root
    folder of the organization space would outlive the folder. One on the
    member's personal home folder, which stays, stays as well."""
    colleague = await make_user(None)
    for folder_id in (lonely.organization_root_id, lonely.personal_home_id):
        db_session.add(
            ResourceGrant(
                resource_type="folder",
                resource_id=folder_id,
                grantee_type="user",
                grantee_id=colleague.id,
                role_id=roles["folder-viewer"],
            )
        )
    await db_session.commit()

    deleted = await _delete(
        lonely.organization_id, await _superuser(db_session, make_user, auth_on)
    )

    assert deleted.status_code == 200, deleted.text
    grants_on = f"SELECT count(*) FROM {S}.resource_grant WHERE resource_id = :f"
    assert not await _scalar(db_session, grants_on, f=lonely.organization_root_id)
    assert await _scalar(db_session, grants_on, f=lonely.personal_home_id)


@pytest.mark.asyncio
async def test_the_organizations_ai_settings_and_model_connections_go_with_it(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
    lonely: Lonely,
) -> None:
    """They name the organization without a foreign key, so they would
    outlive it, the stored API key included. Another organization's stay."""
    other = await make_org()
    assert other.id is not None
    # Read before the commit expires the object.
    other_id = other.id
    for org_id in (lonely.organization_id, other_id):
        connection = AssistantConnection(
            organization_id=org_id,
            name="Own model",
            provider="openai_compatible",
            base_url="https://llm.example.org/v1",
            model="some-model",
            credentials_encrypted="sealed",
        )
        db_session.add(connection)
        await db_session.flush()
        db_session.add(
            AssistantOrganizationSettings(
                organization_id=org_id, active_connection_id=connection.id
            )
        )
    await db_session.commit()

    deleted = await _delete(
        lonely.organization_id, await _superuser(db_session, make_user, auth_on)
    )

    assert deleted.status_code == 200, deleted.text
    db_session.expire_all()
    for model in (AssistantConnection, AssistantOrganizationSettings):
        left = (
            await db_session.execute(
                select(model.organization_id).where(
                    model.organization_id.in_([lonely.organization_id, other_id])
                )
            )
        ).scalars()
        assert set(left) == {other_id}


async def _memberless(
    db: AsyncSession, make_org: Callable[[], Awaitable[Organization]]
) -> tuple[UUID, UUID]:
    """An organization whose last member is gone, with the space root GOAT
    created for it."""
    org = await make_org()
    assert org.id is not None
    space = await crud_space.ensure_organization(db, org.id)
    assert space.id is not None
    root = await crud_space.ensure_root_folder(db, space.id)
    await db.commit()
    return org.id, root


@pytest.mark.asyncio
async def test_an_organization_whose_last_member_is_gone_goes_too(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    org_id, root_id = await _memberless(db_session, make_org)

    deleted = await _delete(org_id, await _superuser(db_session, make_user, auth_on))

    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["user_id"] is None
    assert not await _organization_exists(db_session, org_id)
    assert not await _scalar(
        db_session, f"SELECT count(*) FROM {S}.folder WHERE id = :f", f=root_id
    )


@pytest.mark.asyncio
async def test_an_organization_without_members_but_with_content_stays(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_org: Callable[[], Awaitable[Organization]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    org_id, root_id = await _memberless(db_session, make_org)
    space_id = await _scalar(
        db_session,
        f"SELECT id FROM {S}.space WHERE organization_id = :o",
        o=org_id,
    )
    db_session.add(
        Project(id=uuid4(), folder_id=root_id, space_id=space_id, name="Left over")
    )
    await db_session.commit()

    deleted = await _delete(org_id, await _superuser(db_session, make_user, auth_on))

    assert deleted.status_code == 409, deleted.text
    assert deleted.json()["detail"].endswith("Found projects: 1."), deleted.text
    assert await _organization_exists(db_session, org_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("caller", ["its own owner", "no token"])
async def test_only_a_superuser_may(
    caller: str,
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    lonely: Lonely,
) -> None:
    headers = auth_on(lonely.member_id) if caller == "its own owner" else {}

    deleted = await _delete(lonely.organization_id, headers)

    assert deleted.status_code == 401, deleted.text
    await _assert_untouched(db_session, lonely)


@pytest.mark.asyncio
async def test_an_unknown_organization_is_not_found(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
) -> None:
    deleted = await _delete(uuid4(), await _superuser(db_session, make_user, auth_on))

    assert deleted.status_code == 404, deleted.text
    assert deleted.json()["detail"] == "Organization not found"


# What is added -> how the refusal names it.
BLOCKERS = {
    "a second member": "members: 2",
    "a folder": "folders: 1",
    "a project in the organization space": "projects: 1",
    "a layer in the personal space": "layers: 1",
    "a layer in the trash": "layers: 1",
    "a bundle": "bundles: 1",
    "a template": "templates: 1",
    "a team": "teams: 1",
    "a pending invitation": "pending invitations: 1",
    "a custom domain": "custom domains: 1",
    "analytics settings": "analytics settings: 1",
}


async def _add(
    blocker: str,
    db: AsyncSession,
    world: Lonely,
    make_user: Callable[..., Awaitable[User]],
) -> None:
    org_id, member_id = world.organization_id, world.member_id
    org_space, org_root = world.organization_space_id, world.organization_root_id
    personal, home = world.personal_space_id, world.personal_home_id
    rows: list[object] = []
    if blocker == "a second member":
        await make_user(org_id)
    elif blocker == "a folder":
        rows.append(
            Folder(
                id=uuid4(),
                user_id=member_id,
                space_id=org_space,
                parent_id=org_root,
                name="Plans",
            )
        )
    elif blocker == "a project in the organization space":
        rows.append(
            Project(
                id=uuid4(),
                user_id=member_id,
                folder_id=org_root,
                space_id=org_space,
                name="Shared project",
            )
        )
    elif blocker in ("a layer in the personal space", "a layer in the trash"):
        rows.append(
            Layer(
                id=uuid4(),
                user_id=member_id,
                folder_id=home,
                space_id=personal,
                name="Stops",
                type="feature",
                feature_layer_type="standard",
                feature_layer_geometry_type="point",
                deleted_at=datetime.now(timezone.utc)
                if blocker == "a layer in the trash"
                else None,
            )
        )
    elif blocker == "a bundle":
        rows.append(
            Bundle(
                id=uuid4(),
                user_id=member_id,
                folder_id=home,
                space_id=personal,
                name="Network",
                bundle_type="street_network",
            )
        )
    elif blocker == "a template":
        rows.append(
            Template(
                id=uuid4(),
                name="Starter",
                space_id=org_space,
                folder_id=org_root,
                user_id=member_id,
                payload_kind=TemplatePayloadKind.project,
            )
        )
    elif blocker == "a team":
        rows.append(Team(id=uuid4(), name="Team", avatar="", organization_id=org_id))
    elif blocker == "a pending invitation":
        rows.append(
            Invitation(
                send_by=member_id,
                organization_id=org_id,
                type=InvitationType.organization,
                payload={
                    "user_email": "colleague@goat.test",
                    "organization_id": str(org_id),
                    "role": "organization-viewer",
                },
                status=InvitationStatusEnum.pending,
            )
        )
    elif blocker == "a custom domain":
        rows.append(
            OrganizationDomain(
                id=uuid4(),
                organization_id=org_id,
                base_domain=f"{uuid4().hex[:8]}.example.org",
            )
        )
    elif blocker == "analytics settings":
        rows.append(
            OrganizationAnalytics(
                id=uuid4(),
                organization_id=org_id,
                name="Visits",
                provider="matomo",
                config={"url": "https://matomo.example.org", "site_id": "1"},
            )
        )
    else:  # pragma: no cover
        raise AssertionError(blocker)
    for row in rows:
        db.add(row)
    await db.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("blocker", BLOCKERS)
async def test_refused_while_the_organization_has_anything_in_it(
    blocker: str,
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    lonely: Lonely,
) -> None:
    await _add(blocker, db_session, lonely, make_user)

    deleted = await _delete(
        lonely.organization_id, await _superuser(db_session, make_user, auth_on)
    )

    assert deleted.status_code == 409, deleted.text
    assert deleted.json()["detail"].endswith(
        f"Found {BLOCKERS[blocker]}."
    ), deleted.text
    await _assert_untouched(db_session, lonely)


@pytest.mark.asyncio
async def test_a_failure_part_way_changes_nothing(
    db_session: AsyncSession,
    auth_on: Callable[..., dict[str, str]],
    make_user: Callable[..., Awaitable[User]],
    lonely: Lonely,
) -> None:
    """The organization row is removed last, after the member has been taken
    out of it; a database error there must leave the member in it."""
    headers = await _superuser(db_session, make_user, auth_on)
    await db_session.execute(
        text(
            f"CREATE OR REPLACE FUNCTION {S}.test_refuse_organization_delete() "
            "RETURNS trigger LANGUAGE plpgsql AS "
            "$$ BEGIN RAISE EXCEPTION 'organization delete refused by the test'; END $$"
        )
    )
    await db_session.execute(
        text(
            "CREATE TRIGGER test_refuse_organization_delete "
            f"BEFORE DELETE ON {S}.organization FOR EACH ROW "
            f"WHEN (OLD.id = '{lonely.organization_id}') "
            f"EXECUTE FUNCTION {S}.test_refuse_organization_delete()"
        )
    )
    try:
        deleted = await _delete(lonely.organization_id, headers)
    finally:
        await db_session.execute(
            text(
                "DROP TRIGGER IF EXISTS test_refuse_organization_delete "
                f"ON {S}.organization"
            )
        )

    assert deleted.status_code == 500, deleted.text
    await _assert_untouched(db_session, lonely)
