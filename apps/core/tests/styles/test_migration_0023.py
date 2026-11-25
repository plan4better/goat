"""Migration 0023: saved filters in the panel's form for negations and empty tests.

Runs the revision's `upgrade`/`downgrade` through alembic's operations on the
per-process test schema, like `test_migration_0022.py`, over a project layer
filter, one of a layer the DuckLake catalog does not list, and a published
snapshot.
"""

import builtins
import copy
import importlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio
from alembic.migration import MigrationContext
from alembic.operations import Operations
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.layer import Layer
from core.db.models.project import ProjectPublic
from core.db.session import session_manager
from goatlib.filter.convert import convert_query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

S = settings.SCHEMA
MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "0023_filter_empty_values.py"
)
LAKE = f"ducklake_filters_{os.getpid()}"


def p(name: str) -> dict[str, str]:
    return {"property": name}


NOT_BERLIN = {"op": "!=", "args": [p("name"), "Berlin"]}
QUERY = {
    "cql": {
        "op": "and",
        "args": [
            NOT_BERLIN,
            {"op": "isNull", "args": p("name")},
            {"op": "isNull", "args": p("pop")},
            {"op": "=", "args": [p("kind"), "city"]},
        ],
    },
    "ui": {"v": 1, "off": [{"at": 4, "cql": {"op": "!=", "args": [p("pop"), 5]}}]},
    "metadata": {"by": "panel"},
}
FIELDS = {"name": "string", "kind": "string", "pop": "integer"}
#: A layer the catalog does not list: the empty test stays, the negation changes.
UNLISTED = {
    "cql": {"op": "and", "args": [NOT_BERLIN, {"op": "isNull", "args": p("name")}]}
}


def load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("m0023", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def run(step_name: str) -> None:
    m = load()
    m.S = S

    def step(sync_conn) -> None:  # noqa: ANN001
        context = MigrationContext.configure(sync_conn)
        with Operations.context(context):
            getattr(m, step_name)()

    async with session_manager.connect() as conn:
        await conn.run_sync(step)
        await conn.commit()


@pytest_asyncio.fixture
async def catalog(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> Any:
    """DuckLake's table and column catalog in a scratch schema, with the undo table
    as 0022 leaves it."""
    await db_session.execute(text(f"DROP SCHEMA IF EXISTS {LAKE} CASCADE"))
    await db_session.execute(text(f"CREATE SCHEMA {LAKE}"))
    await db_session.execute(
        text(
            f"CREATE TABLE {LAKE}.ducklake_table (table_id bigint, schema_id bigint, "
            "table_name varchar, begin_snapshot bigint, end_snapshot bigint)"
        )
    )
    await db_session.execute(
        text(
            f"CREATE TABLE {LAKE}.ducklake_column (column_id bigint, table_id bigint, "
            "column_name varchar, column_type varchar, begin_snapshot bigint, "
            "end_snapshot bigint, parent_column bigint)"
        )
    )
    had_undo = (
        await db_session.execute(
            text("SELECT to_regclass(:n) IS NOT NULL"),
            {"n": f"{S}.style_migration_undo"},
        )
    ).scalar()
    await db_session.commit()
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", LAKE)
    yield LAKE
    await db_session.execute(text(f"DROP SCHEMA IF EXISTS {LAKE} CASCADE"))
    if not had_undo:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {S}.style_migration_undo"))
    await db_session.commit()


async def seed(db: AsyncSession, world: StyleWorld) -> dict[str, Any]:
    table = "t_" + world.layer_id.hex
    await db.execute(
        text(
            f"INSERT INTO {LAKE}.ducklake_table VALUES (1, 0, :t, 1, NULL), (2, 0, :t, 0, 1)"
        ),
        {"t": table},
    )
    await db.execute(
        text(
            f"INSERT INTO {LAKE}.ducklake_column VALUES "
            "(1, 1, 'name', 'varchar', 1, NULL, NULL), (2, 1, 'kind', 'varchar', 1, NULL, NULL), "
            "(3, 1, 'pop', 'int32', 1, NULL, NULL), (4, 1, 'geom', 'geometry', 1, NULL, NULL), "
            # A dropped column, a struct's child and the old table's column count for nothing.
            "(5, 1, 'pop', 'varchar', 0, 1, NULL), (6, 1, 'pop', 'varchar', 1, NULL, 9), "
            "(7, 2, 'name', 'int64', 0, 1, NULL)"
        )
    )
    link = await db.get(LayerProjectLink, world.layer_project_id)
    layer = await db.get(Layer, world.layer_id)
    assert link is not None and layer is not None
    link.query = copy.deepcopy(QUERY)
    other = Layer(
        id=uuid4(),
        user_id=world.user_id,
        folder_id=layer.folder_id,
        space_id=layer.space_id,
        name="unlisted",
        type="feature",
        feature_layer_type="standard",
        feature_layer_geometry_type="point",
    )
    db.add(other)
    await db.flush()
    unlisted = LayerProjectLink(
        project_id=world.project_id,
        layer_id=other.id,
        name="unlisted",
        properties={},
        query=copy.deepcopy(UNLISTED),
    )
    db.add(unlisted)
    await db.flush()
    public = ProjectPublic(
        project_id=world.project_id,
        config={
            "layers": [
                {
                    "id": world.layer_project_id,
                    "layer_id": str(world.layer_id),
                    "query": QUERY,
                },
                {"id": unlisted.id, "layer_id": str(other.id), "query": UNLISTED},
            ],
            "map": {
                "version": "1.0.0",
                "layers": [
                    {
                        "type": "group",
                        "id": 1,
                        "name": "g",
                        "visible": True,
                        "children": [
                            {
                                "type": "layer",
                                "id": world.layer_project_id,
                                "filter": QUERY["cql"],
                            }
                        ],
                    },
                    {"type": "layer", "id": unlisted.id, "filter": UNLISTED["cql"]},
                    {
                        "type": "layer",
                        "id": 999,
                        "filter": {"op": "and", "args": [NOT_BERLIN]},
                    },
                ],
            },
            "styles": {},
        },
    )
    db.add(public)
    await db.commit()
    return {"unlisted": unlisted.id, "public": public.id}


async def state(
    db: AsyncSession, world: StyleWorld, ids: dict[str, Any]
) -> dict[str, Any]:
    db.expire_all()
    rows = (
        await db.execute(
            text(f"SELECT id, query FROM {S}.layer_project WHERE id = ANY(:ids)"),
            {"ids": [world.layer_project_id, ids["unlisted"]]},
        )
    ).all()
    public = (
        await db.execute(
            text(f"SELECT config FROM {S}.project_public WHERE id = :id"),
            {"id": ids["public"]},
        )
    ).scalar_one()
    undo = (
        await db.execute(
            text(
                f"SELECT table_name, row_id FROM {S}.style_migration_undo "
                "WHERE table_name LIKE 'filter:%' ORDER BY 1, 2"
            )
        )
    ).all()
    return {"queries": {r[0]: r[1] for r in rows}, "public": public, "undo": undo}


@pytest.mark.asyncio
async def test_upgrade_converts_every_stored_filter_once_and_downgrade_puts_them_back(
    db_session: AsyncSession, style_world: StyleWorld, catalog: str
) -> None:
    ids = await seed(db_session, style_world)
    before = await state(db_session, style_world, ids)

    await run("upgrade")
    after = await state(db_session, style_world, ids)
    lp = style_world.layer_project_id
    assert after["queries"][lp] == convert_query(QUERY, FIELDS).value
    assert after["queries"][ids["unlisted"]] == convert_query(UNLISTED, None).value
    # The negations keep the empty value; "is empty" on text takes the empty text, on a
    # number it stays; switched-off rows change too; the rest stays.
    cql = after["queries"][lp]["cql"]["args"]
    assert cql[0] == {
        "op": "or",
        "args": [
            {"op": "<>", "args": [p("name"), "Berlin"]},
            {"op": "isNull", "args": [p("name")]},
        ],
    }
    assert cql[1] == {
        "op": "or",
        "args": [
            {"op": "isNull", "args": [p("name")]},
            {"op": "=", "args": [p("name"), ""]},
        ],
    }
    assert cql[2:] == QUERY["cql"]["args"][2:]
    assert after["queries"][lp]["ui"]["off"][0]["cql"]["op"] == "or"
    assert after["queries"][lp]["metadata"] == QUERY["metadata"]
    assert (
        after["queries"][ids["unlisted"]]["cql"]["args"][1]
        == UNLISTED["cql"]["args"][1]
    )
    # The snapshot: the layers' queries as the live ones, the map entries the same CQL.
    public = after["public"]
    assert public["layers"][0]["query"] == after["queries"][lp]
    assert public["layers"][1]["query"] == after["queries"][ids["unlisted"]]
    assert (
        public["map"]["layers"][0]["children"][0]["filter"]
        == after["queries"][lp]["cql"]
    )
    assert (
        public["map"]["layers"][1]["filter"] == after["queries"][ids["unlisted"]]["cql"]
    )
    assert public["map"]["layers"][2]["filter"]["args"][0]["op"] == "or"
    assert '"!="' not in json.dumps(after, default=str)
    assert [r[0] for r in after["undo"]] == [
        "filter:layer_project",
        "filter:layer_project",
        "filter:project_public",
    ]

    await run("upgrade")
    assert await state(db_session, style_world, ids) == after

    await run("downgrade")
    restored = await state(db_session, style_world, ids)
    assert restored["queries"] == before["queries"]
    assert restored["public"] == before["public"]
    assert restored["undo"] == []


@pytest.mark.asyncio
async def test_downgrade_keeps_a_filter_saved_after_the_upgrade(
    db_session: AsyncSession, style_world: StyleWorld, catalog: str
) -> None:
    ids = await seed(db_session, style_world)
    await run("upgrade")
    saved = {"cql": {"op": "and", "args": [{"op": "=", "args": [p("kind"), "town"]}]}}
    await db_session.execute(
        text(f"UPDATE {S}.layer_project SET query = CAST(:q AS jsonb) WHERE id = :id"),
        {"q": json.dumps(saved), "id": style_world.layer_project_id},
    )
    await db_session.commit()

    await run("downgrade")
    restored = await state(db_session, style_world, ids)
    assert restored["queries"][style_world.layer_project_id] == saved
    assert restored["queries"][ids["unlisted"]] == UNLISTED


@pytest.mark.asyncio
async def test_without_a_catalog_only_negations_change(
    db_session: AsyncSession,
    style_world: StyleWorld,
    catalog: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = await seed(db_session, style_world)
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", "no_such_lake")
    await run("upgrade")
    after = await state(db_session, style_world, ids)
    assert (
        after["queries"][style_world.layer_project_id]
        == convert_query(QUERY, None).value
    )
    await run("downgrade")


@pytest.mark.parametrize(
    ("column_type", "expected"),
    [
        ("varchar", "string"),
        ("int32", "integer"),
        ("int64", "integer"),
        ("uint8", "integer"),
        ("hugeint", "integer"),
        ("float64", "number"),
        ("float32", "number"),
        ("decimal(3,2)", "number"),
        ("boolean", "boolean"),
        ("date", "datetime"),
        ("timestamp", "datetime"),
        ("timestamptz", "datetime"),
        ("time", None),
        ("interval", None),
        ("blob", None),
        ("uuid", None),
        ("struct", None),
        ("list", None),
        ("json", None),
        ("geometry", None),
    ],
)
def test_catalog_column_types(column_type: str, expected: str | None) -> None:
    assert load().field_type("name", column_type) == expected


@pytest.mark.parametrize(
    "name", ["id", "layer_id", "geom", "geometry", "bbox", "h3_8", "$minx"]
)
def test_columns_the_panel_lists_no_field_for_have_no_type(name: str) -> None:
    assert load().field_type(name, "varchar") is None


def test_the_revision_loads_without_the_geospatial_stack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """core's image has no geospatial stack; the revision and the conversion must
    load there."""
    absent = ("pyarrow", "duckdb", "shapely", "geopandas", "pyproj", "osgeo", "numpy")
    real_import = builtins.__import__

    def guarded(name: str, *args: object, **kwargs: object) -> object:
        if name.split(".")[0] in absent:
            raise ModuleNotFoundError(f"No module named {name.split('.')[0]!r}")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    for mod in list(sys.modules):
        if mod.split(".")[0] in absent or mod == "goatlib.filter.convert":
            monkeypatch.delitem(sys.modules, mod, raising=False)
    monkeypatch.setattr(builtins, "__import__", guarded)
    convert = importlib.import_module("goatlib.filter.convert")
    assert convert.convert_query({"cql": NOT_BERLIN}, None).changes
    load()
