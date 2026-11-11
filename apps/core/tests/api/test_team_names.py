"""Team names are unique within an organization, ignoring case and spaces (B1).

Core trims a team's name and answers 409 when another team of the same
organization has it. Renaming a team to its own name passes; a team of
another organization with the same name does not count. There is no unique
index: duplicates made before this check stay until someone renames them,
and a save that keeps such a team's name passes (P2-15). A name that is
empty after trimming, or not a string, is invalid input (422, P2-13).
"""

from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from core.core.config import settings
from core.db.models.team import Team
from core.db.models.user import User
from core.services.s3 import s3_service
from core.utils.i18n import language, trans
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from tests.utils import as_user, make_organization, seeded_roles

TEAMS = f"{settings.API_V2_STR}/teams"
TAKEN = "A team with this name already exists in the organization"
# A 1x1 PNG, as the web's image picker sends it.
PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


@pytest.fixture
async def two_orgs(db_session: AsyncSession) -> dict[str, Any]:
    await seeded_roles(db_session)  # the team-owner role create_team looks up
    org, other_org = make_organization(id=uuid4()), make_organization(id=uuid4())
    db_session.add_all([org, other_org])
    await db_session.flush()
    users = {
        name: User(
            id=uuid4(),
            email=f"names-{uuid4().hex[:8]}@goat.test",
            firstname=name.title(),
            lastname="Test",
            avatar="",
            organization_id=organization_id,
        )
        # carol has no organization; the default user is not used for that,
        # as other tests put it into one (org_with_default_user).
        for name, organization_id in (
            ("alice", org.id),
            ("bob", other_org.id),
            ("carol", None),
        )
    }
    db_session.add_all(users.values())
    await db_session.commit()
    return {**{name: user.id for name, user in users.items()}, "org": org.id}


async def _create(client: AsyncClient, user_id: Any, name: str):
    return await client.post(TEAMS, json={"name": name}, headers=as_user(user_id))


@pytest.mark.asyncio
async def test_a_duplicate_name_is_refused_on_create_whatever_its_case_and_spaces(
    client: AsyncClient, two_orgs: dict[str, Any]
) -> None:
    first = await _create(client, two_orgs["alice"], "  Planung ")
    assert first.status_code == 200, first.text
    assert first.json()["name"] == "Planung"
    for name in ("planung", " PLANUNG  ", "Planung"):
        again = await _create(client, two_orgs["alice"], name)
        assert again.status_code == 409, (name, again.text)
        assert again.json()["detail"] == TAKEN


@pytest.mark.asyncio
async def test_another_organizations_team_of_the_same_name_does_not_count(
    client: AsyncClient, two_orgs: dict[str, Any]
) -> None:
    assert (await _create(client, two_orgs["alice"], "Verkehr")).status_code == 200
    assert (await _create(client, two_orgs["bob"], "verkehr")).status_code == 200


@pytest.mark.asyncio
async def test_a_rename_is_refused_onto_another_teams_name_but_not_its_own(
    client: AsyncClient, two_orgs: dict[str, Any]
) -> None:
    alice = two_orgs["alice"]
    umwelt = (await _create(client, alice, "Umwelt")).json()["id"]
    bauen = (await _create(client, alice, "Bauen")).json()["id"]

    clash = await client.patch(
        f"{TEAMS}/{bauen}/profile", json={"name": " umwelt"}, headers=as_user(alice)
    )
    assert clash.status_code == 409, clash.text
    assert clash.json()["detail"] == TAKEN

    own = await client.patch(
        f"{TEAMS}/{umwelt}/profile", json={"name": " UMWELT "}, headers=as_user(alice)
    )
    assert own.status_code == 200, own.text
    assert own.json()["name"] == "UMWELT"

    without_name = await client.patch(
        f"{TEAMS}/{bauen}/profile",
        json={"description": "Hochbau"},
        headers=as_user(alice),
    )
    assert without_name.status_code == 200, without_name.text


@pytest.mark.asyncio
async def test_a_name_empty_after_trimming_or_not_a_string_is_invalid_input(
    client: AsyncClient, two_orgs: dict[str, Any]
) -> None:
    alice = two_orgs["alice"]
    invalid: list[Any] = ["", "   ", 5, None]
    for name in [*invalid, "x" * 256]:
        created = await client.post(TEAMS, json={"name": name}, headers=as_user(alice))
        assert created.status_code == 422, (name, created.text)

    team = (await _create(client, alice, "Statistik")).json()["id"]
    for name in [*invalid, "x" * 256]:
        renamed = await client.patch(
            f"{TEAMS}/{team}/profile", json={"name": name}, headers=as_user(alice)
        )
        assert renamed.status_code == 422, (name, renamed.text)
    stored = await client.get(f"{TEAMS}/{team}", headers=as_user(alice))
    assert stored.json()["name"] == "Statistik"


@pytest.mark.asyncio
async def test_an_unchanged_name_never_clashes_so_a_legacy_duplicate_still_saves(
    client: AsyncClient, db_session: AsyncSession, two_orgs: dict[str, Any]
) -> None:
    alice = two_orgs["alice"]
    planung = (await _create(client, alice, "Planung")).json()["id"]
    assert (await _create(client, alice, "Hafen")).status_code == 200
    # A duplicate made before core checked names.
    db_session.add(
        Team(id=uuid4(), name="Planung", avatar="", organization_id=two_orgs["org"])
    )
    await db_session.commit()

    # The web's profile card always sends the name along.
    saved = await client.patch(
        f"{TEAMS}/{planung}/profile",
        json={"name": " Planung ", "description": "Bauleitplanung"},
        headers=as_user(alice),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["name"] == "Planung"
    assert saved.json()["description"] == "Bauleitplanung"

    # Another team's name, and a new spelling of its own (a different name).
    for name in ("hafen", "PLANUNG"):
        clash = await client.patch(
            f"{TEAMS}/{planung}/profile", json={"name": name}, headers=as_user(alice)
        )
        assert clash.status_code == 409, (name, clash.text)
        assert clash.json()["detail"] == TAKEN


@pytest.mark.asyncio
async def test_teams_without_an_organization_never_clash(
    client: AsyncClient, two_orgs: dict[str, Any]
) -> None:
    for _ in range(2):
        created = await _create(client, two_orgs["carol"], "X")
        assert created.status_code == 200, created.text


@pytest.mark.asyncio
async def test_a_rename_onto_another_organizations_team_name_passes(
    client: AsyncClient, two_orgs: dict[str, Any]
) -> None:
    alice = two_orgs["alice"]
    assert (await _create(client, two_orgs["bob"], "Hafenamt")).status_code == 200
    markt = (await _create(client, alice, "Markt")).json()["id"]

    renamed = await client.patch(
        f"{TEAMS}/{markt}/profile", json={"name": "hafenamt"}, headers=as_user(alice)
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "hafenamt"


@pytest.mark.asyncio
async def test_a_refused_rename_uploads_no_picture(
    client: AsyncClient, two_orgs: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    upload = MagicMock()
    monkeypatch.setattr(s3_service, "upload_asset", upload)
    alice = two_orgs["alice"]
    assert (await _create(client, alice, "Umwelt")).status_code == 200
    bauen = (await _create(client, alice, "Bauen")).json()["id"]

    refused = await client.patch(
        f"{TEAMS}/{bauen}/profile",
        json={"name": "umwelt", "avatar": PNG},
        headers=as_user(alice),
    )
    assert refused.status_code == 409, refused.text
    upload.assert_not_called()

    # The same save under a free name uploads, so the mock does see uploads.
    accepted = await client.patch(
        f"{TEAMS}/{bauen}/profile",
        json={"name": "Hochbau", "avatar": PNG},
        headers=as_user(alice),
    )
    assert accepted.status_code == 200, accepted.text
    upload.assert_called_once()


@pytest.mark.unit
def test_the_conflict_has_a_german_text_for_callers_that_set_a_language() -> None:
    with language("de"):
        assert (
            trans(TAKEN)
            == "Ein Team mit diesem Namen gibt es in der Organisation schon"
        )
