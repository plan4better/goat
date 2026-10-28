"""The map request (spec 13.2): the map document from the tables, every layer's
active style, the other style names, an ETag, and `stale` from the tracker."""

from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectGroup, LayerProjectLink
from core.db.models.layer_style import LayerStyle
from goatlib.style.models.map_document import MapDocument
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import LAKE, StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA
FILL = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#111111"}}}


@pytest.fixture(autouse=True)
def tracker_reads_the_scratch_lake(lake: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)


async def style(
    db: AsyncSession,
    layer_project_id: int,
    name: str,
    position: int = 0,
    document: dict[str, Any] = FILL,
) -> UUID:
    row = LayerStyle(
        layer_project_id=layer_project_id,
        name=name,
        position=position,
        document=document,
    )
    db.add(row)
    await db.commit()
    assert row.id is not None
    return row.id


async def link(
    db: AsyncSession,
    world: StyleWorld,
    name: str,
    group: int | None,
    order: int,
    **extra: Any,
) -> int:
    row = LayerProjectLink(
        project_id=world.project_id,
        layer_id=world.layer_id,
        name=name,
        properties={},
        layer_project_group_id=group,
        order=order,
        **extra,
    )
    db.add(row)
    await db.commit()
    assert row.id is not None
    return row.id


async def get_map(client: AsyncClient, world: StyleWorld, **headers: str):
    return await client.get(f"{API}/project/{world.project_id}/map", headers=headers)


@pytest.mark.asyncio
async def test_the_map_document_follows_the_tables(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    mobility = LayerProjectGroup(name="Mobility", project_id=world.project_id, order=0)
    db_session.add(mobility)
    await db_session.commit()
    hidden = LayerProjectGroup(
        name="Hidden",
        project_id=world.project_id,
        order=1,
        parent_id=mobility.id,
        visible=False,
    )
    db_session.add(hidden)
    await db_session.commit()
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_project SET \"order\" = 1, position = 'below_labels', "
            "query = CAST(:q AS jsonb), legend_expanded = false WHERE id = :id"
        ),
        {
            "id": world.layer_project_id,
            "q": '{"cql": {"op": "<>", "args": [{"property": "land_use"}, "green"]}}',
        },
    )
    await db_session.commit()
    inside = await link(db_session, world, "inside", mobility.id, 0, time_value=2024)
    deep = await link(db_session, world, "deep", hidden.id, 0, visible=False)
    active = await style(db_session, world.layer_project_id, "Population")
    second = await style(db_session, world.layer_project_id, "Density", position=1)
    await db_session.execute(
        text(f"UPDATE {S}.layer_project SET active_style_id = :s WHERE id = :id"),
        {"s": active, "id": world.layer_project_id},
    )
    await db_session.commit()

    response = await get_map(client, world)
    assert response.status_code == 200, response.text
    body = response.json()
    document = body["map"]
    MapDocument.model_validate(document)
    # Links created without style rows get their "Default" on this load (the
    # rollout repair): their entries name it.
    repaired = {lp: body["styles"][str(lp)]["active"]["id"] for lp in (inside, deep)}
    assert document["layers"] == [
        {
            "type": "group",
            "id": mobility.id,
            "name": "Mobility",
            "visible": True,
            "children": [
                {
                    "type": "layer",
                    "id": inside,
                    "visible": True,
                    "style": repaired[inside],
                    "time": {"value": 2024},
                },
                {
                    "type": "group",
                    "id": hidden.id,
                    "name": "Hidden",
                    "visible": False,
                    "children": [
                        {
                            "type": "layer",
                            "id": deep,
                            "visible": False,
                            "style": repaired[deep],
                        }
                    ],
                },
            ],
        },
        {
            "type": "layer",
            "id": world.layer_project_id,
            "visible": True,
            "style": str(active),
            "position": "below_labels",
            "filter": {"op": "<>", "args": [{"property": "land_use"}, "green"]},
            "legend": {"expanded": False},
        },
    ]
    styles = body["styles"][str(world.layer_project_id)]
    assert styles["active"]["id"] == str(active)
    assert styles["active"]["document"] == FILL
    assert styles["active"]["stale"] is False
    assert styles["others"] == [{"id": str(second), "name": "Density"}]
    assert set(body["styles"]) == {
        str(lp) for lp in (world.layer_project_id, inside, deep)
    }


@pytest.mark.asyncio
async def test_the_first_style_stands_in_for_a_deleted_active_one(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    first = await style(db_session, world.layer_project_id, "First", position=0)
    await style(db_session, world.layer_project_id, "Second", position=1)
    body = (await get_map(client, world)).json()
    assert body["map"]["layers"][0]["style"] == str(first)
    assert body["styles"][str(world.layer_project_id)]["active"]["id"] == str(first)


@pytest.mark.asyncio
async def test_an_unchanged_project_answers_304(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    await style(db_session, world.layer_project_id, "Only")
    first = await get_map(client, world)
    etag = first.headers["etag"]
    again = await get_map(client, world, **{"If-None-Match": etag})
    assert again.status_code == 304
    await db_session.execute(
        text(f"UPDATE {S}.layer_project SET visible = false WHERE id = :id"),
        {"id": world.layer_project_id},
    )
    await db_session.commit()
    changed = await get_map(client, world, **{"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag


@pytest.mark.asyncio
async def test_a_browser_on_another_origin_can_read_the_etag(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    """The web app runs on another origin than core: without the header exposed, its
    fetch cannot read the ETag and never sends `If-None-Match`."""
    response = await get_map(client, api_style_world, Origin="http://localhost:3000")
    assert response.status_code == 200
    exposed = response.headers.get("access-control-expose-headers", "")
    assert "etag" in exposed.lower()


@pytest.mark.asyncio
async def test_a_changed_data_snapshot_marks_the_style_stale(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    classified = {
        **FILL,
        "classify": [
            {
                "id": "density",
                "field": "density",
                "method": "quantile",
                "count": 2,
                "classes": [{"id": "c1", "to": 5}, {"id": "c2", "from": 5}],
                "computed": {"at": "2026-10-25T10:00:00Z", "data": "ducklake:0"},
            }
        ],
    }
    await style(db_session, world.layer_project_id, "Classified", document=classified)
    body = (await get_map(client, world)).json()
    assert body["styles"][str(world.layer_project_id)]["active"]["stale"] is False
    await db_session.execute(
        text(f"INSERT INTO {LAKE}.ducklake_table VALUES (7, :name)"),
        {"name": f"t_{world.layer_id.hex}"},
    )
    await db_session.execute(text(f"INSERT INTO {LAKE}.ducklake_snapshot VALUES (5)"))
    await db_session.execute(
        text(
            f"INSERT INTO {LAKE}.ducklake_snapshot_changes VALUES (5, 'inserted_into_table:7')"
        )
    )
    await db_session.commit()
    body = (await get_map(client, world)).json()
    assert body["styles"][str(world.layer_project_id)]["active"]["stale"] is True


@pytest.mark.asyncio
async def test_a_layer_without_style_rows_gets_its_default_on_the_next_load(
    client: AsyncClient, api_style_world: StyleWorld
) -> None:
    """A writer of the previous release created it during the rollout."""
    response = await get_map(client, api_style_world)
    assert response.status_code == 200, response.text
    body = response.json()
    active = body["styles"][str(api_style_world.layer_project_id)]["active"]
    assert active["name"] == "Default"
    assert body["map"]["layers"] == [
        {
            "type": "layer",
            "id": api_style_world.layer_project_id,
            "visible": True,
            "style": active["id"],
        }
    ]
    again = (await get_map(client, api_style_world)).json()
    assert (
        again["styles"][str(api_style_world.layer_project_id)]["active"]["id"]
        == active["id"]
    )


@pytest.mark.asyncio
async def test_a_collapsed_group_says_expanded_false(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    group = LayerProjectGroup(
        name="Closed", project_id=world.project_id, order=0, expanded=False
    )
    db_session.add(group)
    await db_session.commit()
    body = (await get_map(client, world)).json()
    entry = next(e for e in body["map"]["layers"] if e["type"] == "group")
    assert entry["expanded"] is False
    MapDocument.model_validate(body["map"])


def test_the_builder_assembles_plain_rows() -> None:
    """The one assembly path: the live map request and the data migration (from a
    published snapshot) both call it with plain rows."""
    from goatlib.style.map_rows import GroupRow, LayerRow, build_map_document

    document = build_map_document(
        basemap="light",
        locale="de-DE",
        view_state={"longitude": 11.5, "latitude": 48.1, "zoom": 12},
        bounds=None,
        groups=[
            GroupRow(
                id=1, name="G", parent_id=None, order=0, visible=True, expanded=True
            )
        ],
        layers=[
            LayerRow(
                id=10,
                group_id=1,
                order=0,
                visible=False,
                position="top",
                query=None,
                time_value=None,
                legend_expanded=True,
                style_id=None,
            ),
            LayerRow(
                id=11,
                group_id=None,
                order=1,
                visible=True,
                position="below_labels",
                query={"cql": {"op": "isNull", "args": [{"property": "a"}]}},
                time_value=2024,
                legend_expanded=False,
                style_id=UUID(int=5),
            ),
        ],
    )
    assert document == {
        "version": 1,
        "basemap": {"id": "light"},
        "view": {"center": [11.5, 48.1], "zoom": 12},
        "locale": "de-DE",
        "layers": [
            {
                "type": "group",
                "id": 1,
                "name": "G",
                "visible": True,
                "children": [{"type": "layer", "id": 10, "visible": False}],
            },
            {
                "type": "layer",
                "id": 11,
                "visible": True,
                "style": str(UUID(int=5)),
                "position": "below_labels",
                "filter": {"op": "isNull", "args": [{"property": "a"}]},
                "time": {"value": 2024},
                "legend": {"expanded": False},
            },
        ],
    }
    MapDocument.model_validate(document)
