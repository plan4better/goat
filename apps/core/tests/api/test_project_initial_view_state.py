"""HTTP-level coverage for the `user_project` (initial view state) lazy
fallback introduced when the fan-out share triggers were retired: with no
row for the requester or the project owner (e.g. a project reassigned by
`remove_user`, whose old owner's row was cascade-deleted), the endpoint now
returns the same default a brand-new project gets instead of 404ing on a
project the caller otherwise has access to. Also proves that the deleted
create-time `project_user` insert was redundant — ownership resolves from
`Project.user_id` alone."""

from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.crud.crud_project import DEFAULT_INITIAL_VIEW_STATE
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

S = settings.SCHEMA

_CREATE_PAYLOAD_VIEW_STATE = {
    "latitude": 48.1502132,
    "longitude": 11.5696284,
    "zoom": 12,
    "min_zoom": 0,
    "max_zoom": 20,
    "bearing": 0,
    "pitch": 0,
}


async def _create_project(
    client: AsyncClient, folder_id: str, name: str
) -> dict[str, Any]:
    response = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "folder_id": folder_id,
            "name": name,
            "initial_view_state": _CREATE_PAYLOAD_VIEW_STATE,
        },
    )
    assert response.status_code in (200, 201), response.text
    result: dict[str, Any] = response.json()
    return result


@pytest.mark.asyncio
async def test_initial_view_state_falls_back_to_default_when_no_row_exists(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """Every `user_project` row for the project is gone (the offboarding-heir
    edge case) — the endpoint must still return 200 with the same default a
    fresh project gets, not 404."""
    project = await _create_project(
        client, fixture_create_folder["id"], "no-user-project-row"
    )
    project_id = project["id"]

    before = (
        await db_session.execute(
            text(f'SELECT count(*) FROM "{S}".user_project WHERE project_id = :p'),
            {"p": project_id},
        )
    ).scalar_one()
    assert before > 0, "the create endpoint must have written a user_project row"

    await db_session.execute(
        text(f'DELETE FROM "{S}".user_project WHERE project_id = :p'),
        {"p": project_id},
    )
    await db_session.commit()

    response = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/initial-view-state"
    )
    assert response.status_code == 200, response.text
    assert response.json() == DEFAULT_INITIAL_VIEW_STATE


@pytest.mark.asyncio
async def test_initial_view_state_returns_stored_state_when_row_exists(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """The normal path — a `user_project` row is present with a state that
    differs from the default — is unaffected by the fallback and still
    returns the stored state, not the default. Writes it via the update
    endpoint (distinct from the create-time coverage in
    `test_create_with_custom_initial_view_state_is_read_back_unchanged`)."""
    project = await _create_project(
        client, fixture_create_folder["id"], "user-project-row-present"
    )
    project_id = project["id"]

    distinct_view_state = {
        "latitude": 48.1502132,
        "longitude": 11.5696284,
        "zoom": 12,
        "min_zoom": 1,
        "max_zoom": 18,
        "bearing": 30,
        "pitch": 15,
    }
    put_response = await client.put(
        f"{settings.API_V2_STR}/project/{project_id}/initial-view-state",
        json=distinct_view_state,
    )
    assert put_response.status_code == 200, put_response.text

    response = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/initial-view-state"
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body != DEFAULT_INITIAL_VIEW_STATE
    assert body["latitude"] == pytest.approx(distinct_view_state["latitude"])
    assert body["longitude"] == pytest.approx(distinct_view_state["longitude"])
    assert body["zoom"] == distinct_view_state["zoom"]


@pytest.mark.asyncio
async def test_create_with_custom_initial_view_state_is_read_back_unchanged(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """Parked fix: `crud_project.create` must seed the owner's row from the
    POST payload's `initial_view_state` when one is given, not silently
    discard it in favor of the default."""
    project = await _create_project(
        client, fixture_create_folder["id"], "custom-view-state-on-create"
    )
    project_id = project["id"]

    response = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/initial-view-state"
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body != DEFAULT_INITIAL_VIEW_STATE
    for key, value in _CREATE_PAYLOAD_VIEW_STATE.items():
        assert body[key] == pytest.approx(value)


@pytest.mark.asyncio
async def test_creator_is_project_owner_without_a_project_user_insert(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """The create endpoint no longer writes a `project_user` grant row (that
    table is gone); ownership must still resolve to `project-owner` purely
    from `Project.user_id`, read by `effective_role`."""
    project = await _create_project(client, fixture_create_folder["id"], "owner-role")
    project_id = project["id"]

    response = await client.get(f"{settings.API_V2_STR}/project/{project_id}")
    assert response.status_code == 200, response.text
    assert response.json()["my_role"] == "project-owner"


@pytest.mark.asyncio
async def test_initial_view_state_404s_on_a_trashed_project_via_the_fallback(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """A trashed project behaves as gone for every normal route reached via
    project_id — this one included. The owner's own `user_project` row
    would otherwise short-circuit straight to a (stale) stored view state,
    so this drives the no-personal-row fallback branch (same setup as
    ``test_initial_view_state_falls_back_to_default_when_no_row_exists``),
    which now uses `get_live_or_404` rather than a bare `get` that never
    checked `deleted_at`."""
    project = await _create_project(client, fixture_create_folder["id"], "trashed")
    project_id = project["id"]
    await db_session.execute(
        text(f'DELETE FROM "{S}".user_project WHERE project_id = :p'),
        {"p": project_id},
    )
    await db_session.commit()

    deleted = await client.delete(f"{settings.API_V2_STR}/project/{project_id}")
    assert deleted.status_code in (200, 204), deleted.text

    response = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/initial-view-state"
    )
    assert response.status_code == 404, response.text


@pytest.mark.asyncio
async def test_create_without_a_view_state_is_accepted_and_seeded(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """The field is optional: a caller that sends none still gets a project
    with a usable starting view, chosen by the server."""
    response = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"folder_id": fixture_create_folder["id"], "name": "no-view-state"},
    )
    assert response.status_code in (200, 201), response.text
    project_id = response.json()["id"]

    read = await client.get(
        f"{settings.API_V2_STR}/project/{project_id}/initial-view-state"
    )
    assert read.status_code == 200, read.text
    view_state = read.json()
    assert isinstance(view_state["latitude"], (int, float))
    assert isinstance(view_state["longitude"], (int, float))


@pytest.mark.asyncio
async def test_a_second_project_inherits_the_last_opened_view(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """The history rung: someone who cannot be placed by address — every
    caller here, and every caller through a load balancer that does not forward
    one — keeps landing where they last worked."""
    first = await _create_project(client, fixture_create_folder["id"], "first")
    # Opening a project is what stamps `last_opened_at`.
    assert (
        await client.get(f"{settings.API_V2_STR}/project/{first['id']}")
    ).status_code == 200

    moved = {**_CREATE_PAYLOAD_VIEW_STATE, "latitude": 52.52, "longitude": 13.405}
    updated = await client.put(
        f"{settings.API_V2_STR}/project/{first['id']}/initial-view-state", json=moved
    )
    assert updated.status_code == 200, updated.text

    response = await client.post(
        f"{settings.API_V2_STR}/project",
        json={"folder_id": fixture_create_folder["id"], "name": "second"},
    )
    assert response.status_code in (200, 201), response.text
    inherited = await client.get(
        f"{settings.API_V2_STR}/project/{response.json()['id']}/initial-view-state"
    )
    assert inherited.status_code == 200, inherited.text
    assert inherited.json()["latitude"] == pytest.approx(52.52)
    assert inherited.json()["longitude"] == pytest.approx(13.405)


@pytest.mark.asyncio
async def test_an_explicit_view_state_still_wins(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """An API client that states a view gets that view, whatever the caller's
    location or history would otherwise suggest."""
    first = await _create_project(client, fixture_create_folder["id"], "history")
    assert (
        await client.get(f"{settings.API_V2_STR}/project/{first['id']}")
    ).status_code == 200

    asked = {**_CREATE_PAYLOAD_VIEW_STATE, "latitude": 41.3275, "longitude": 19.8187}
    response = await client.post(
        f"{settings.API_V2_STR}/project",
        json={
            "folder_id": fixture_create_folder["id"],
            "name": "explicit",
            "initial_view_state": asked,
        },
    )
    assert response.status_code in (200, 201), response.text
    read = await client.get(
        f"{settings.API_V2_STR}/project/{response.json()['id']}/initial-view-state"
    )
    assert read.json()["latitude"] == pytest.approx(41.3275)


@pytest.mark.asyncio
async def test_view_keeps_maplibre_numbers_and_3d_keys(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """MapLibre's own numbers (a fractional zoom, a negative fractional bearing,
    a fractional pitch) are stored, the bearing normalised to 0 (incl.) to 360
    (excl.)."""
    project = await _create_project(client, fixture_create_folder["id"], "3D")
    body = {
        **_CREATE_PAYLOAD_VIEW_STATE,
        "zoom": 15.7,
        "bearing": -20.5,
        "pitch": 55.3,
        "mode": "3d",
        "projection": "globe",
    }
    url = f"{settings.API_V2_STR}/project/{project['id']}/initial-view-state"
    put = await client.put(url, json=body)
    assert put.status_code == 200, put.text
    read = (await client.get(url)).json()
    assert read["zoom"] == 15.7
    assert read["bearing"] == 339.5 and read["pitch"] == 55.3
    assert read["mode"] == "3d" and read["projection"] == "globe"


@pytest.mark.asyncio
async def test_view_without_3d_keys_stores_none_of_them(
    client: AsyncClient,
    db_session: AsyncSession,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    """A view saved without `mode` and `projection` stays without them (missing
    `mode` follows the pitch), and a bearing of 360 reads as 0."""
    project = await _create_project(client, fixture_create_folder["id"], "Flat")
    url = f"{settings.API_V2_STR}/project/{project['id']}/initial-view-state"
    put = await client.put(url, json={**_CREATE_PAYLOAD_VIEW_STATE, "bearing": 360})
    assert put.status_code == 200, put.text
    stored = (
        await db_session.execute(
            text(
                f'SELECT initial_view_state FROM "{S}".user_project '
                "WHERE project_id = :p"
            ),
            {"p": project["id"]},
        )
    ).scalar_one()
    assert "mode" not in stored and "projection" not in stored
    assert stored["bearing"] == 0


@pytest.mark.asyncio
async def test_view_refuses_pitch_above_85(
    client: AsyncClient,
    fixture_create_user: UUID,
    fixture_create_folder: dict[str, Any],
) -> None:
    project = await _create_project(client, fixture_create_folder["id"], "Steep")
    url = f"{settings.API_V2_STR}/project/{project['id']}/initial-view-state"
    for refused in (
        {"pitch": 86},
        {"mode": "4d"},
        {"projection": "albers"},
        {"bearing": True},
        {"zoom": 24.5},
    ):
        put = await client.put(url, json={**_CREATE_PAYLOAD_VIEW_STATE, **refused})
        assert put.status_code == 422, refused
