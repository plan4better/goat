"""Project archives carry styles (format 1.2): a layer's default style, a
project layer's named styles with the active one, the map state of layers and
groups, and the uploaded icons the styles name. Older archives (1.0, 1.1) carry
today's `properties`, which the import converts."""

import json
import uuid
from pathlib import Path
from typing import Any

import asyncpg
import pytest
from goatlib.tools.base import ToolSettings
from goatlib.tools.db import ToolDatabaseService
from goatlib.tools.project_export import ProjectExportRunner, archive_files
from goatlib.tools.project_import import ProjectImportRunner

from .conftest import TEST_CUSTOMER_SCHEMA, TEST_FOLDER_ID, TEST_USER_ID

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]

S = TEST_CUSTOMER_SCHEMA
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'


def icon_style(asset_id: str) -> dict[str, Any]:
    return {
        "version": 1,
        "kind": "vector",
        "symbol": {"marker": {"shape": "icon", "icon": f"asset:{asset_id}"}},
    }


def write(archive: Path, files: dict[str, Any]) -> None:
    for name, content in files.items():
        path = archive / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(json.dumps(content, default=str))


async def new_project(pool: asyncpg.Pool) -> str:
    project_id = str(uuid.uuid4())
    await pool.execute(
        f"INSERT INTO {S}.project (id, user_id, folder_id, name) VALUES ($1, $2, $3, 'P')",
        uuid.UUID(project_id),
        uuid.UUID(TEST_USER_ID),
        uuid.UUID(TEST_FOLDER_ID),
    )
    return project_id


async def imported(
    archive: Path,
    settings: ToolSettings,
    data_snapshots: dict[str, int] | None = None,
) -> tuple[str, dict[str, str]]:
    runner = ProjectImportRunner()
    runner.settings = settings
    id_map = runner._generate_id_mapping(archive)
    project_id = str(uuid.uuid4())
    await runner._insert_pg_records(
        archive_dir=archive,
        id_map=id_map,
        new_project_id=project_id,
        new_user_id=TEST_USER_ID,
        target_folder_id=TEST_FOLDER_ID,
        data_snapshots=data_snapshots,
    )
    return project_id, id_map


async def links_of(pool: asyncpg.Pool, project_id: str) -> list[Any]:
    return await pool.fetch(
        f"""
        SELECT lp.id, lp.layer_id, lp.visible, lp.position, lp.time_value,
               lp.legend_expanded, g.visible AS group_visible,
               g.expanded AS group_expanded,
               (SELECT json_agg(json_build_object(
                    'name', s.name, 'position', s.position,
                    'document', s.document, 'active', s.id = lp.active_style_id,
                    'revisions', (SELECT count(*) FROM {S}.layer_style_revision r
                                  WHERE r.style_id = s.id))
                ORDER BY s.position)
                FROM {S}.layer_style s WHERE s.layer_project_id = lp.id) AS styles,
               (SELECT d.document FROM {S}.layer_style d
                WHERE d.layer_id = lp.layer_id) AS default_style
        FROM {S}.layer_project lp
        LEFT JOIN {S}.layer_project_group g ON g.id = lp.layer_project_group_id
        WHERE lp.project_id = $1 ORDER BY lp.id
        """,
        uuid.UUID(project_id),
    )


async def test_a_1_2_round_trip_keeps_every_named_style_the_active_one_and_map_state(
    db_service: ToolDatabaseService,
    postgres_pool: asyncpg.Pool,
    tool_settings: ToolSettings,
    test_folder: dict[str, Any],
    tmp_path: Path,
) -> None:
    project_id = await new_project(postgres_pool)
    asset_id = str(uuid.uuid4())
    await postgres_pool.execute(
        f"""
        INSERT INTO {S}.uploaded_asset
            (id, user_id, s3_key, file_name, mime_type, file_size, asset_type, content_hash)
        VALUES ($1, $2, $3, 'pin.svg', 'image/svg+xml', $4, 'icon', 'x')
        """,
        uuid.UUID(asset_id),
        uuid.UUID(TEST_USER_ID),
        f"assets/{TEST_USER_ID}/{asset_id}.svg",
        len(SVG),
    )
    layer_id = str(uuid.uuid4())
    await db_service.create_layer(
        layer_id=layer_id,
        user_id=TEST_USER_ID,
        folder_id=TEST_FOLDER_ID,
        name="Pins",
        geometry_type="POINT",
        style=icon_style(asset_id),
    )
    link_id = await db_service.add_to_project(
        layer_id=layer_id, project_id=project_id, name="Pins"
    )
    density = {"version": 1, "kind": "vector", "symbol": {"marker": {"size": 4}}}
    group_id = await postgres_pool.fetchval(
        f"""INSERT INTO {S}.layer_project_group (name, project_id, visible, expanded)
            VALUES ('G', $1, false, false) RETURNING id""",
        uuid.UUID(project_id),
    )
    await postgres_pool.execute(
        f"""
        WITH s AS (
            INSERT INTO {S}.layer_style (layer_project_id, name, position, document)
            VALUES ($1, 'Density', 1, $2::jsonb) RETURNING id
        )
        UPDATE {S}.layer_project SET active_style_id = (SELECT id FROM s),
            visible = false, position = 'below_labels', time_value = '2024',
            legend_expanded = false, layer_project_group_id = $3
        WHERE id = $1
        """,
        link_id,
        json.dumps(density),
        group_id,
    )
    exporter = ProjectExportRunner()
    exporter.settings = tool_settings
    metadata = await exporter._gather_metadata(project_id, TEST_USER_ID)
    [asset] = metadata["assets"]
    assert (asset["id"], asset["archive_path"]) == (asset_id, f"assets/{asset_id}.svg")

    archive = tmp_path / "archive"
    write(archive, {**archive_files(metadata), asset["archive_path"]: SVG})
    new_project_id, id_map = await imported(archive, tool_settings)

    new_asset = id_map[asset_id]
    [link] = await links_of(postgres_pool, new_project_id)
    assert json.loads(link["default_style"]) == icon_style(new_asset)
    assert [
        (s["name"], s["position"], s["active"], s["revisions"])
        for s in json.loads(link["styles"])
    ] == [("Default", 0, False, 1), ("Density", 1, True, 1)]
    assert [s["document"] for s in json.loads(link["styles"])] == [
        icon_style(new_asset),
        density,
    ]
    assert (
        link["visible"],
        link["position"],
        json.loads(link["time_value"]),
        link["legend_expanded"],
    ) == (False, "below_labels", 2024, False)
    assert (link["group_visible"], link["group_expanded"]) == (False, False)
    row = await postgres_pool.fetchrow(
        f"SELECT user_id, s3_key, content_hash FROM {S}.uploaded_asset WHERE id = $1",
        uuid.UUID(new_asset),
    )
    assert row is not None and row["s3_key"] == f"assets/{TEST_USER_ID}/{new_asset}.svg"


async def test_a_1_1_archive_imports_with_style_rows_and_map_state(
    postgres_pool: asyncpg.Pool,
    tool_settings: ToolSettings,
    test_folder: dict[str, Any],
    tmp_path: Path,
) -> None:
    """An export from before the release: `properties` everywhere, a custom
    icon named by its URL only."""
    old_layer, old_table, old_asset = (str(uuid.uuid4()) for _ in range(3))
    key = f"assets/{uuid.uuid4()}/{old_asset}.svg"
    marker = {"name": "pin", "url": f"https://goat.example/{key}", "source": "custom"}
    archive = tmp_path / "archive"
    write(
        archive,
        {
            "manifest.json": {
                "format_version": "1.1",
                "exported_at": "2026-01-01T00:00:00Z",
                "project_name": "Old",
            },
            "project.json": {"name": "Old"},
            "layers/index.json": {
                "layers": [
                    {
                        "id": old_layer,
                        "name": "Pins",
                        "type": "feature",
                        "feature_layer_type": "standard",
                        "feature_layer_geometry_type": "point",
                        "properties": {"color": [255, 0, 0], "filled": True},
                    },
                    {"id": old_table, "name": "Table", "type": "table"},
                ]
            },
            "layer_project_links.json": {
                "links": [
                    {
                        "id": 7,
                        "layer_id": old_layer,
                        "name": "Pins",
                        "layer_project_group_id": 3,
                        "properties": {
                            "custom_marker": True,
                            "marker": marker,
                            "filled": True,
                            "visibility": False,
                            "legend": {"collapsed": True},
                        },
                    },
                    {
                        "id": 8,
                        "layer_id": old_table,
                        "name": "Table",
                        "properties": {"visibility": False},
                    },
                ]
            },
            "layer_groups.json": {
                "groups": [
                    {
                        "id": 3,
                        "name": "G",
                        "properties": {"visibility": False, "expanded": False},
                    }
                ]
            },
            "assets/index.json": {
                "assets": [
                    {
                        "id": old_asset,
                        "s3_key": key,
                        "file_name": "pin.svg",
                        "mime_type": "image/svg+xml",
                        "asset_type": "icon",
                        "archive_path": f"assets/{old_asset}.svg",
                    }
                ]
            },
            f"assets/{old_asset}.svg": SVG,
        },
    )
    new_project_id, id_map = await imported(archive, tool_settings)
    pins, table = await links_of(postgres_pool, new_project_id)

    assert json.loads(pins["default_style"])["symbol"]["marker"]["color"] == "#ff0000"
    [style] = json.loads(pins["styles"])
    assert (style["name"], style["active"], style["revisions"]) == ("Default", True, 1)
    assert style["document"]["symbol"]["marker"]["icon"] == f"asset:{id_map[old_asset]}"
    assert (pins["visible"], pins["legend_expanded"]) == (False, False)
    assert (pins["group_visible"], pins["group_expanded"]) == (False, False)
    # A table has no style rows; its map state moves all the same.
    assert table["styles"] is None and table["default_style"] is None
    assert table["visible"] is False


async def test_imported_classes_are_stamped_with_the_imported_tables_snapshot(
    postgres_pool: asyncpg.Pool,
    tool_settings: ToolSettings,
    test_folder: dict[str, Any],
    tmp_path: Path,
) -> None:
    """The archive's rows are the data the classes were computed from, so the
    imported project opens without recomputing them."""
    old_layer = str(uuid.uuid4())
    stamp = {"at": "2026-01-01T00:00:00Z", "data": "ducklake:7", "scope": "dataset"}
    classified = {
        "version": 1,
        "kind": "vector",
        "symbol": {"fill": {"color": "#00aa00"}},
        "classify": [
            {
                "id": "c1",
                "field": "v",
                "method": "quantile",
                "count": 2,
                "classes": [{"id": "k1", "to": 5}, {"id": "k2", "from": 5}],
                "computed": stamp,
            }
        ],
    }
    archive = tmp_path / "archive"
    write(
        archive,
        {
            "project.json": {"name": "Classified"},
            "layers/index.json": {
                "layers": [
                    {
                        "id": old_layer,
                        "name": "Cells",
                        "type": "feature",
                        "feature_layer_geometry_type": "polygon",
                        "style": classified,
                    }
                ]
            },
            "layer_project_links.json": {
                "links": [
                    {
                        "id": 1,
                        "layer_id": old_layer,
                        "name": "Cells",
                        "styles": [
                            {"name": "Default", "document": classified, "active": True}
                        ],
                    }
                ]
            },
            "layer_groups.json": {"groups": []},
        },
    )
    new_project_id, _ = await imported(archive, tool_settings, {old_layer: 99})
    [link] = await links_of(postgres_pool, new_project_id)
    [style] = json.loads(link["styles"])
    for document in (style["document"], json.loads(link["default_style"])):
        assert document["classify"][0]["computed"]["data"] == "ducklake:99"
    snapshot = await postgres_pool.fetchval(
        f"SELECT data_snapshot FROM {S}.layer WHERE id = $1", link["layer_id"]
    )
    assert snapshot == 99
