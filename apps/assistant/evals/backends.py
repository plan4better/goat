"""Fixed backends for the evals: what the tools talk to (decision E16).

The catalog tools reach the real catalog app over its own fixture catalog
(apps/catalog/tests/fixtures/gen_catalog.py, seed 42) plus the named rows
below, through an ASGI transport. The project tools reach canned core,
geoapi and processes answers for one fixture project; the answers are
computed from fixed, filter-aware feature tables, so the oracles that grade
the answers read the same tables.

The workflow suite has projects of its own: one to build in, the same layers
for a user who may only view them, and an empty one in Munich, to which
adding a catalog dataset adds its layers. Processes answers with descriptions
captured from processes (``tests/fixtures/process_descriptions.json``) and a
stand-in for its workflow check (``fixture_check``) that follows processes'
check, the tools' own parameter models included. Core keeps the workflows it
saves for the graders. A fourth project holds a workflow whose run processes
refuses before it starts, and processes' runs are a stand-in too
(``_run_routes``): after the same check, a run of a saved workflow saves
``RESULT_LAYER``, which ``aggregation-stats`` groups.
"""

import contextlib
import importlib.util
import json
import os
import random
import re
import statistics
import sys
import uuid
from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import FastAPI
from goatlib.tools.registry import get_tool
from goatlib.tools.workflow_arguments import build_check_arguments
from goatlib.tools.workflow_runner import (
    VARIABLE_PATTERN,
    resolve_variables,
    variable_map,
)
from goatlib.workflows.checks import Issue, dangling_edges, find_loops, shape_issues
from goatlib.workflows.visibility import is_shown
from pydantic import ValidationError

from assistant.tools.http import ServiceClients
from assistant.tools.testing import Recorder, RecordingTransport, fake_clients
from assistant.workflows.tool_info import (
    LAYER_WIDGETS,
    NOT_SETTING_SECTIONS,
    NOT_SETTING_WIDGETS,
    OPPORTUNITIES,
)
from evals.tasks import Oracle

ROOT = Path(__file__).resolve().parents[3]
GEN_CATALOG = ROOT / "apps" / "catalog" / "tests" / "fixtures" / "gen_catalog.py"

# ---- catalog ------------------------------------------------------------------

#: Named rows the catalog tasks expect: id, topic, region, category, license,
#: language, type, index (the generator's row index: title year 2018 + index % 9).
EVAL_ROWS: tuple[tuple[str, str, str, str, str, str, str, int], ...] = (
    (
        "eval-ladesaeulen-leipzig",
        "Ladesäulen",
        "Leipzig",
        "transportation",
        "dl-de-by-2.0",
        "de",
        "feature",
        1001,
    ),
    (
        "eval-strassenbaeume-koeln",
        "Straßenbäume",
        "Köln",
        "environment",
        "CC0-1.0",
        "de",
        "feature",
        1002,
    ),
    (
        "eval-laermkarte-hamburg",
        "Lärmkarte Straßenverkehr",
        "Hamburg",
        "environment",
        "dl-de-zero-2.0",
        "de",
        "feature",
        1003,
    ),
    (
        "eval-bike-sharing-berlin",
        "Bike sharing stations",
        "Berlin",
        "transportation",
        "ODbL-1.0",
        "en",
        "feature",
        1004,
    ),
    (
        "eval-hochwasser-dresden",
        "Überschwemmungsgebiete",
        "Dresden",
        "environment",
        "dl-de-by-2.0",
        "de",
        "feature",
        1005,
    ),
    (
        "eval-einwohner-muenchen",
        "Einwohner nach Stadtbezirk",
        "München",
        "people",
        "CC-BY-4.0",
        "de",
        "table",
        1006,
    ),
    (
        "eval-solardach-stuttgart",
        "Solarkataster Dachflächen",
        "Stuttgart",
        "environment",
        "CC-BY-4.0",
        "de",
        "feature",
        1007,
    ),
    (
        "eval-ladesaeulen-bayern",
        "Ladesäulen",
        "Bayern",
        "transportation",
        "CC-BY-4.0",
        "de",
        "feature",
        1008,
    ),
    (
        "eval-radverkehr-zaehlstellen-frankfurt",
        "Radverkehr Zählstellen",
        "Frankfurt am Main",
        "transportation",
        "dl-de-by-2.0",
        "de",
        "feature",
        1009,
    ),
    (
        "eval-wohnungsbau-nrw",
        "Wohnungsbaupotenziale",
        "Nordrhein-Westfalen",
        "landuse",
        "other",
        "de",
        "feature",
        1010,
    ),
    # Bavaria-wide: a workflow in Munich limits them to its area.
    (
        "eval-supermaerkte-bayern",
        "Supermärkte",
        "Bayern",
        "places",
        "ODbL-1.0",
        "de",
        "feature",
        1011,
    ),
    (
        "eval-schulen-bayern",
        "Schulen",
        "Bayern",
        "places",
        "dl-de-by-2.0",
        "de",
        "feature",
        1012,
    ),
)


def _generator() -> ModuleType:
    # Not a package: loaded by path, registered first because its dataclasses
    # look their module up in sys.modules (as plan 3's conftest does).
    spec = importlib.util.spec_from_file_location("catalog_fixture_gen", GEN_CATALOG)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["catalog_fixture_gen"] = module
    spec.loader.exec_module(module)
    return module


#: The same playground dataset in four places, its text naming none of them:
#: only a search filtered by region tells the Munich one apart.
#: id, west, south, east, north.
REGION_ROWS: tuple[tuple[str, float, float, float, float], ...] = (
    ("eval-spielplaetze-muenchen", 11.45, 48.12, 11.55, 48.18),
    ("eval-spielplaetze-hamburg", 9.95, 53.52, 10.05, 53.58),
    ("eval-spielplaetze-koeln", 6.90, 50.90, 7.00, 50.96),
    ("eval-spielplaetze-dresden", 13.70, 51.02, 13.80, 51.08),
)
#: The Munich region (district-free city) the playground rows are found by.
MUNICH_REGION = (
    "DE212",
    "München, Kreisfreie Stadt",
    3,
    "DE",
    11.36,
    48.06,
    11.72,
    48.25,
)

#: Where the named rows' places really are (west, south, east, north), so a
#: search filtered by region finds them as it would in the real catalog.
PLACE_BOXES: dict[str, tuple[float, float, float, float]] = {
    "Leipzig": (12.24, 51.24, 12.54, 51.45),
    "Köln": (6.77, 50.83, 7.16, 51.09),
    "Hamburg": (9.73, 53.39, 10.33, 53.74),
    "Berlin": (13.09, 52.34, 13.76, 52.68),
    "Dresden": (13.58, 50.97, 13.97, 51.18),
    "München": (11.36, 48.06, 11.72, 48.25),
    "Stuttgart": (9.04, 48.69, 9.32, 48.87),
    "Frankfurt am Main": (8.47, 50.02, 8.80, 50.23),
    "Bayern": (8.98, 47.27, 13.84, 50.56),
    "Nordrhein-Westfalen": (5.87, 50.32, 9.46, 52.53),
}
#: The cities as regions (NUTS level 3), as catalog_find_region knows them.
CITY_REGIONS: tuple[tuple[str, str, str], ...] = (
    ("DED51", "Leipzig, Kreisfreie Stadt", "Leipzig"),
    ("DEA23", "Köln, Kreisfreie Stadt", "Köln"),
    ("DE600", "Hamburg", "Hamburg"),
    ("DE300", "Berlin", "Berlin"),
    ("DED21", "Dresden, Kreisfreie Stadt", "Dresden"),
    ("DE111", "Stuttgart, Stadtkreis", "Stuttgart"),
    ("DE712", "Frankfurt am Main, Kreisfreie Stadt", "Frankfurt am Main"),
)
#: The generated states and country, in their real extent instead of a random
#: rectangle, so filtering by a state finds what lies in it.
STATE_BOXES: dict[str, tuple[float, float, float, float]] = {
    "DE": (5.87, 47.27, 15.04, 55.06),
    "DE1": (7.51, 47.53, 10.50, 49.79),
    "DE2": PLACE_BOXES["Bayern"],
    "DE3": PLACE_BOXES["Berlin"],
    "DE6": PLACE_BOXES["Hamburg"],
    "DE7": (7.77, 49.39, 10.24, 51.66),
    "DEA": PLACE_BOXES["Nordrhein-Westfalen"],
    "DED": (11.87, 50.17, 15.04, 51.68),
}


def _inside(
    box: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """A footprint in the middle of a place's box."""
    west, south, east, north = box
    dx, dy = (east - west) / 4, (north - south) / 4
    return west + dx, south + dy, east - dx, north - dy


def _box(
    west: float, south: float, east: float, north: float
) -> tuple[str, dict[str, Any]]:
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    wkt = "POLYGON((" + ",".join(f"{x} {y}" for x, y in ring) + "))"
    return wkt, {"type": "Polygon", "coordinates": [ring]}


def eval_rows() -> list[Any]:
    """Each named row as an item plus its one-layer dataset (a Collection)."""
    gen = _generator()
    rows: list[Any] = []
    for (
        row_id,
        topic,
        region,
        category,
        license_id,
        language,
        row_type,
        index,
    ) in EVAL_ROWS:
        item = gen._make_row(
            random.Random(index),
            index,
            topic=topic,
            region=region,
            license_id=license_id,
            category=category,
            language=language,
            row_type=row_type,
        )
        wkt, geojson = _box(*_inside(PLACE_BOXES[region]))
        # A row that adds a fixture layer has that layer's geometry type: the
        # generator draws one at random, and the record describes the layer
        # that adding it gives.
        added = CATALOG_LAYERS.get(row_id)
        item = replace(
            item,
            id=row_id,
            parquet_url=f"{gen.PARQUET_ASSET_BASE_URL}/{row_id}.parquet",
            geometry_wkt=wkt,
            geometry_geojson=geojson,
            geom_type=added.geometry if added is not None else item.geom_type,
        )
        dataset = gen._dataset_collection_for(item)
        rows.extend([replace(item, collection=dataset.id), dataset])
    for n, (row_id, west, south, east, north) in enumerate(REGION_ROWS):
        wkt, geojson = _box(west, south, east, north)
        item = replace(
            gen._make_row(
                random.Random(2001 + n),
                2001 + n,
                topic="Spielplätze",
                region="Stadtgebiet",
                license_id="dl-de-by-2.0",
                category="places",
                language="de",
                row_type="feature",
            ),
            id=row_id,
            title="Öffentliche Spielplätze",
            description=(
                "Öffentliche Spielplätze im Stadtgebiet mit Lage, Ausstattung "
                "und Altersgruppen."
            ),
            geometry_wkt=wkt,
            geometry_geojson=geojson,
            parquet_url=f"{gen.PARQUET_ASSET_BASE_URL}/{row_id}.parquet",
        )
        dataset = gen._dataset_collection_for(item)
        rows.extend([replace(item, collection=dataset.id), dataset])
    return rows


def write_eval_catalog(path: Path) -> None:
    gen = _generator()
    build_document = gen.build_document

    def with_dataset_metadata(
        row: Any, member_bboxes: list[list[float]] | None = None
    ) -> Any:
        # The generator keeps a collection's themes only under ``summaries`` and
        # no language at all, but the mirror reads a dataset's category and
        # language from the collection's own ``themes`` and ``language`` (as the
        # published catalog has them). Without them every dataset has no theme.
        document = build_document(row, member_bboxes)
        if document.get("type") == "Collection":
            document = {
                **document,
                "themes": document["summaries"]["themes"],
                "language": {"code": row.language},
            }
        layer = CATALOG_LAYERS.get(str(document.get("id")))
        if layer is not None and document.get("type") == "Feature":
            # The columns the record lists are the fields of the layer that
            # adding the dataset gives: a model reading them while the layer
            # is still copying finds the names geoapi lists later.
            document = {
                **document,
                "properties": {
                    **document["properties"],
                    "table:columns": [
                        {"name": name, "type": kind}
                        for name, kind in layer.fields.items()
                    ],
                },
            }
        return document

    setattr(gen, "build_document", with_dataset_metadata)
    gen.write_catalog(path, extra_rows=eval_rows())
    nuts_id, name, level, country, *box = MUNICH_REGION
    cities = [
        (city_id, city_name, 3, "DE", _box(*PLACE_BOXES[place])[0])
        for city_id, city_name, place in CITY_REGIONS
    ]
    gen.write_nuts(
        path,
        extra_regions=[(nuts_id, name, level, country, _box(*box)[0]), *cities],
        replace_regions={key: _box(*value)[0] for key, value in STATE_BOXES.items()},
    )


@contextlib.contextmanager
def _without_catalog_env() -> Iterator[None]:
    """A developer's .env must not reach the catalog's settings (an aliased
    variable plus a keyword is an extra-input error)."""
    from catalog.config import CatalogSettings

    names = set()
    for settings_field in CatalogSettings.model_fields.values():
        alias = settings_field.validation_alias
        for name in getattr(alias, "choices", [alias]) if alias is not None else []:
            if isinstance(name, str):
                names.add(name)
    saved = {name: os.environ.pop(name) for name in names if name in os.environ}
    try:
        yield
    finally:
        os.environ.update(saved)


def catalog_app(path: Path) -> FastAPI:
    from catalog.app import create_app
    from catalog.config import CatalogSettings
    from catalog.store import CatalogStore

    with _without_catalog_env():
        settings = CatalogSettings(**{"data_dir": path, "AUTH": False})
    app: FastAPI = create_app(settings)
    # What the catalog's lifespan does; an ASGI transport runs no lifespan.
    app.state.store = CatalogStore(settings)
    app.state.preview_reader = None
    app.state.asset_reader = None
    return app


# ---- fixture project ----------------------------------------------------------

PROJECT_ID = "00000000-0000-0000-0000-0000000005e1"
PROJECT_NAME = "Radverkehr Leipzig"
BEZIRKE = (
    "Mitte",
    "Nordost",
    "Ost",
    "Südost",
    "Süd",
    "Südwest",
    "West",
    "Alt-West",
    "Nordwest",
    "Nord",
)


@dataclass(frozen=True)
class FixtureLayer:
    layer_project_id: int
    layer_id: str
    name: str
    geometry: str  # point, line, polygon; empty for a table
    fields: Mapping[str, str]  # name -> JSON type
    features: tuple[dict[str, Any], ...]  # properties plus "_at": (lon, lat)
    locked: bool = False
    group_id: int | None = None
    layer_type: str = "feature"


def _at(rng: random.Random) -> tuple[float, float]:
    return (round(rng.uniform(12.25, 12.55), 5), round(rng.uniform(51.25, 51.45), 5))


def _build_layers() -> tuple[FixtureLayer, ...]:
    rng = random.Random(7)
    arts = (
        ["Radweg"] * 32
        + ["Radfahrstreifen"] * 20
        + ["Schutzstreifen"] * 16
        + ["Fahrradstraße"] * 12
    )
    rng.shuffle(arts)
    radwege = tuple(
        {
            "art": art,
            "laenge_m": round(rng.uniform(50, 2500), 1),
            "baujahr": rng.randint(1990, 2024),
            "beleuchtet": rng.random() < 0.6,
            "bezirk": rng.choice(BEZIRKE),
            "_at": _at(rng),
        }
        for art in arts
    )
    bezirke = tuple(
        {
            "name": name,
            "einwohner": rng.randint(20_000, 90_000),
            "flaeche_m2": round(rng.uniform(8e6, 40e6), 1),
            "_at": _at(rng),
        }
        for name in BEZIRKE
    )
    racks_by_district = [
        b
        for b, n in zip(BEZIRKE, (24, 18, 15, 13, 12, 11, 9, 8, 6, 4), strict=True)
        for _ in range(n)
    ]
    rng.shuffle(racks_by_district)
    staender = tuple(
        {
            "stellplaetze": rng.randint(2, 40),
            "ueberdacht": rng.random() < 0.3,
            "bezirk": b,
            "_at": _at(rng),
        }
        for b in racks_by_district
    )
    planung = tuple({"status": "Entwurf", "_at": _at(rng)} for _ in range(5))
    return (
        FixtureLayer(
            21,
            "e1000000-0000-0000-0000-000000000021",
            "Radwege",
            "line",
            {
                "art": "string",
                "laenge_m": "number",
                "baujahr": "integer",
                "beleuchtet": "boolean",
                "bezirk": "string",
            },
            radwege,
            group_id=1,
        ),
        FixtureLayer(
            22,
            "e1000000-0000-0000-0000-000000000022",
            "Bezirke",
            "polygon",
            {"name": "string", "einwohner": "integer", "flaeche_m2": "number"},
            bezirke,
        ),
        FixtureLayer(
            23,
            "e1000000-0000-0000-0000-000000000023",
            "Fahrradständer",
            "point",
            {"stellplaetze": "integer", "ueberdacht": "boolean", "bezirk": "string"},
            staender,
            group_id=1,
        ),
        FixtureLayer(
            24,
            "e1000000-0000-0000-0000-000000000024",
            "Interne Planung",
            "polygon",
            {"status": "string"},
            planung,
            locked=True,
        ),
    )


FIXTURE_LAYERS = _build_layers()

# ---- workflow projects ---------------------------------------------------------

WF_PROJECT_ID = "00000000-0000-0000-0000-0000000005e4"
VIEWER_PROJECT_ID = "00000000-0000-0000-0000-0000000005e5"
EMPTY_PROJECT_ID = "00000000-0000-0000-0000-0000000005e6"
WF_PROJECT_NAME = "Erreichbarkeit Leipzig"
EMPTY_PROJECT_NAME = "Neues Projekt München"
RUN_PROJECT_ID = "00000000-0000-0000-0000-0000000005e7"
RUN_PROJECT_NAME = "Schulwege Leipzig"
RUN_WORKFLOW_ID = "0b6f0000-0000-0000-0000-0000000000e1"
#: Every fixture project's folder: a run is submitted with it.
FOLDER_ID = "0f000000-0000-0000-0000-000000000001"


def _build_workflow_layers() -> tuple[FixtureLayer, ...]:
    rng = random.Random(11)
    kinds = ["Grundschule"] * 6 + ["Gymnasium"] * 3 + ["Oberschule"] * 3
    schools = tuple(
        {"name": f"Schule {n}", "schulart": kind, "_at": _at(rng)}
        for n, kind in enumerate(kinds, start=1)
    )
    residents = tuple(
        {"einwohner": rng.randint(50, 900), "_at": _at(rng)} for _ in range(40)
    )
    chains = ["Edeka", "Rewe", "Lidl", "Aldi"] * 3
    shops = tuple(
        {"name": f"Markt {n}", "kette": chain, "_at": _at(rng)}
        for n, chain in enumerate(chains, start=1)
    )
    # Without residents: "the residents" has one layer to come from.
    districts = tuple({"name": name, "_at": _at(rng)} for name in BEZIRKE)
    school_fields = {"name": "string", "schulart": "string"}
    return (
        FixtureLayer(
            31,
            "e2000000-0000-0000-0000-000000000031",
            "Schulen",
            "point",
            school_fields,
            schools,
        ),
        FixtureLayer(
            32,
            "e2000000-0000-0000-0000-000000000032",
            "Schulen (Stand 2019)",
            "point",
            school_fields,
            schools[:9],
        ),
        FixtureLayer(
            33,
            "e2000000-0000-0000-0000-000000000033",
            "Einwohner Raster",
            "polygon",
            {"einwohner": "integer"},
            residents,
        ),
        FixtureLayer(
            34,
            "e2000000-0000-0000-0000-000000000034",
            "Supermärkte",
            "point",
            {"name": "string", "kette": "string"},
            shops,
        ),
        FixtureLayer(
            35,
            "e2000000-0000-0000-0000-000000000035",
            "Stadtbezirke",
            "polygon",
            {"name": "string"},
            districts,
        ),
    )


WORKFLOW_LAYERS = _build_workflow_layers()
#: Residents per district and band: what a run of a saved workflow saves for
#: each of its export steps.
RESULT_ROWS: tuple[tuple[str, int, int], ...] = (
    ("Mitte", 5, 1200),
    ("Mitte", 10, 2600),
    ("Mitte", 15, 4100),
    ("Nord", 5, 300),
    ("Nord", 10, 900),
    ("Nord", 15, 1500),
    ("Süd", 5, 800),
    ("Süd", 10, 1700),
    ("Süd", 15, 2900),
)
RESULT_LAYER = FixtureLayer(
    37,
    "e2000000-0000-0000-0000-000000000037",
    "Einwohner je Bezirk und Band",
    "polygon",
    {"name": "string", "band": "integer", "einwohner": "integer"},
    tuple(
        {"name": name, "band": band, "einwohner": people, "_at": (12.37, 51.34)}
        for name, band, people in RESULT_ROWS
    ),
)
#: The run project's workflow: walking catchments in three bands whose band
#: edges do not rise, so the check finds its catchment's settings invalid and
#: processes refuses its run before it starts.
RUN_WORKFLOW: dict[str, Any] = {
    "id": RUN_WORKFLOW_ID,
    "project_id": RUN_PROJECT_ID,
    "name": "Schulwege 15 Minuten",
    "description": None,
    "is_default": False,
    "config": {
        "nodes": [
            {
                "id": "dataset-schulen",
                "type": "dataset",
                "position": {"x": 0, "y": 0},
                "data": {
                    "type": "dataset",
                    "label": "Schulen",
                    "layerId": WORKFLOW_LAYERS[0].layer_id,
                },
            },
            {
                "id": "tool-walk",
                "type": "tool",
                "position": {"x": 320, "y": 0},
                "data": {
                    "type": "tool",
                    "processId": "catchment_area_v2",
                    "label": "15 Minuten zu Fuß",
                    "config": {
                        "routing_mode": "walking",
                        "max_cost": 15,
                        "steps": 3,
                        "step_sizes": [5, 5, 5],
                    },
                },
            },
            {
                "id": "export-walk",
                "type": "export",
                "position": {"x": 640, "y": 0},
                "data": {
                    "type": "export",
                    "label": "Save as dataset",
                    "datasetName": "Schulwege",
                },
            },
        ],
        "edges": [
            {
                "id": "e1",
                "source": "dataset-schulen",
                "target": "tool-walk",
                "targetHandle": "starting_points",
            },
            {"id": "e2", "source": "tool-walk", "target": "export-walk"},
        ],
        "variables": [],
    },
}
#: The layer adding a catalog dataset gives, by catalog id.
CATALOG_LAYERS: dict[str, FixtureLayer] = {
    "eval-supermaerkte-bayern": replace(
        WORKFLOW_LAYERS[3],
        layer_project_id=41,
        layer_id="e2000000-0000-0000-0000-000000000041",
        name="Supermärkte Bayern",
    ),
    "eval-schulen-bayern": replace(
        WORKFLOW_LAYERS[0],
        layer_project_id=42,
        layer_id="e2000000-0000-0000-0000-000000000042",
        name="Schulen Bayern",
    ),
}
TEMPLATE_ID = "7e000000-0000-0000-0000-0000000000a1"
#: A workflow template: catchment areas on foot around schools.
TEMPLATE: dict[str, Any] = {
    "id": TEMPLATE_ID,
    "name": "Schools within walking distance",
    "description": "Catchment areas on foot around the schools (Schulen, zu Fuß).",
    "categories": ["Education"],
    "payload_kind": "workflow",
    "inputs": [
        {
            "key": "node:dataset-schools",
            "label": "Schools",
            "mode": "ask",
            "layer_type": "feature",
            "geometry_type": "point",
        }
    ],
}
#: The template's workflow as core keeps it: the schools step asks for its
#: layer, then a 15-minute walk from the schools, its result saved.
TEMPLATE_CONFIG: dict[str, Any] = {
    "nodes": [
        {
            "id": "dataset-schools",
            "type": "dataset",
            "position": {"x": 0, "y": 0},
            "data": {
                "type": "dataset",
                "label": "Schools",
                "templateInput": "node:dataset-schools",
                "unresolved": True,
            },
        },
        {
            "id": "tool-walk",
            "type": "tool",
            "position": {"x": 360, "y": 0},
            "data": {
                "type": "tool",
                "processId": "catchment_area_v2",
                "label": "catchment_area_v2",
                "config": {"routing_mode": "walking", "max_cost": 15, "steps": 1},
                "status": "idle",
            },
        },
        {
            "id": "export-walk",
            "type": "export",
            "position": {"x": 720, "y": 0},
            "data": {
                "type": "export",
                "label": "Walking distance",
                "datasetName": "Schools within walking distance",
                "addToProject": True,
                "overwritePrevious": False,
            },
        },
    ],
    "edges": [
        {
            "id": "edge-schools-walk",
            "source": "dataset-schools",
            "target": "tool-walk",
            "targetHandle": "starting_points",
        },
        {
            "id": "edge-walk-export",
            "source": "tool-walk",
            "sourceHandle": "output",
            "target": "export-walk",
            "targetHandle": "input",
        },
    ],
    "viewport": {"x": 0, "y": 0, "zoom": 1},
    "variables": [],
}
_BY_ID = {
    layer.layer_id: layer
    for layer in (
        *FIXTURE_LAYERS,
        *WORKFLOW_LAYERS,
        RESULT_LAYER,
        *CATALOG_LAYERS.values(),
    )
}


def layer_project_id(layer_id: str) -> int | None:
    """The layer_project_id of a fixed layer (the projects' own and those of
    ``CATALOG_LAYERS``) by its layer id; None for any other, such as a layer
    a task added from the catalog, which no task's ``layers`` names."""
    layer = _BY_ID.get(layer_id)
    return layer.layer_project_id if layer is not None else None


def _layer_named(name: str | None) -> FixtureLayer:
    for layer in FIXTURE_LAYERS:
        if layer.name == name:
            return layer
    raise KeyError(f"no fixture layer {name!r}")


# CQL2-JSON as plan 3's filters produce it (=, <>, <, <=, >, >=, in, like,
# isNull, not, and, or; date-times as {"timestamp": ...}).
def _value(arg: Any, properties: Mapping[str, Any]) -> Any:
    if isinstance(arg, dict) and "property" in arg:
        return properties.get(arg["property"])
    if isinstance(arg, dict) and "timestamp" in arg:
        return arg["timestamp"]
    return arg


def _like(pattern: str) -> str:
    return "".join(
        ".*" if c == "%" else "." if c == "_" else re.escape(c) for c in pattern
    )


def matches(
    expression: Mapping[str, Any] | None, properties: Mapping[str, Any]
) -> bool:
    if expression is None:
        return True
    op = expression["op"]
    args = expression.get("args", [])
    if op == "and":
        return all(matches(arg, properties) for arg in args)
    if op == "or":
        return any(matches(arg, properties) for arg in args)
    if op == "not":
        return not matches(args[0], properties)
    left = _value(args[0], properties)
    if op == "isNull":
        return left is None
    if op == "in":
        return left in [_value(arg, properties) for arg in args[1]]
    right = _value(args[1], properties)
    if left is None or right is None:
        return False
    if op == "like":
        # ILIKE: case-insensitive, as the filter tool's contract says.
        return re.fullmatch(_like(str(right)), str(left), re.IGNORECASE) is not None
    comparisons: dict[str, Callable[[Any, Any], bool]] = {
        "=": lambda a, b: a == b,
        "<>": lambda a, b: a != b,
        "<": lambda a, b: a < b,
        "<=": lambda a, b: a <= b,
        ">": lambda a, b: a > b,
        ">=": lambda a, b: a >= b,
    }
    try:
        return bool(comparisons[op](left, right))
    except TypeError:
        return False


def _selected(layer: FixtureLayer, raw_filter: Any) -> list[dict[str, Any]]:
    expression = json.loads(raw_filter) if isinstance(raw_filter, str) else raw_filter
    return [feature for feature in layer.features if matches(expression, feature)]


def _geometry(layer: FixtureLayer, at: tuple[float, float]) -> dict[str, Any]:
    lon, lat = at
    if layer.geometry == "point":
        return {"type": "Point", "coordinates": [lon, lat]}
    if layer.geometry == "line":
        return {
            "type": "LineString",
            "coordinates": [[lon, lat], [lon + 0.01, lat + 0.005]],
        }
    ring = [
        [lon, lat],
        [lon + 0.02, lat],
        [lon + 0.02, lat + 0.02],
        [lon, lat + 0.02],
        [lon, lat],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def _public(feature: Mapping[str, Any], fields: list[str] | None) -> dict[str, Any]:
    return {
        k: v
        for k, v in feature.items()
        if not k.startswith("_") and (fields is None or k in fields)
    }


#: A dataset the user's organization already has: a data question should find
#: it next to the catalog's (``core_find`` before ``catalog_search``).
ORG_DATASET = {
    "type": "layer",
    "id": "00000000-0000-0000-0000-00000000da7a",
    "name": "Ladesäulen Stadtwerke Leipzig",
    "description": "Charging points of the municipal utility, updated monthly.",
    "layer_type": "feature",
    "geometry_type": "point",
    "my_role": "viewer",
    "space_kind": "organization",
    "space_name": "Stadt Leipzig",
    "folder_path": ["Verkehr"],
    "matched_on": ["name"],
    "updated_at": "2026-09-01T00:00:00Z",
}
#: The layer adding ``ORG_DATASET`` to a workflow project gives. The dataset's
#: data is not part of the fixture: the layer has no fields and no features.
ORG_DATASET_LAYER = FixtureLayer(
    38,
    str(ORG_DATASET["id"]),
    str(ORG_DATASET["name"]),
    str(ORG_DATASET["geometry_type"]),
    {},
    (),
)


def _content_search(request: httpx.Request) -> httpx.Response:
    """Core's search over what the user can open, as core matches: part of the
    name, case-insensitive."""
    search = request.url.params.get("search", "").casefold()
    types = request.url.params.get("types", "layer").split(",")
    hit = "layer" in types and search in str(ORG_DATASET["name"]).casefold()
    return httpx.Response(
        200, json={"items": [ORG_DATASET] if hit else [], "total": int(hit)}
    )


def _core_routes() -> dict[tuple[str, str], Any]:
    base = f"/api/v2/project/{PROJECT_ID}"
    layers = [
        {
            "id": layer.layer_project_id,
            "layer_id": layer.layer_id,
            "name": layer.name,
            "type": "feature",
            "feature_layer_geometry_type": layer.geometry,
            "layer_project_group_id": layer.group_id,
            "order": order,
            "locked": layer.locked,
        }
        for order, layer in enumerate(FIXTURE_LAYERS)
    ]
    return {
        ("GET", base): {"id": PROJECT_ID, "name": PROJECT_NAME, "folder_id": FOLDER_ID},
        ("GET", f"{base}/layer"): layers,
        ("GET", f"{base}/group"): [
            {"id": 1, "name": "Verkehr", "parent_id": None, "order": 0}
        ],
        # The project has no workflows and no print layouts.
        ("GET", f"{base}/workflow"): [],
        ("GET", f"{base}/report-layout"): [],
        ("GET", "/api/v2/content/search"): _content_search,
        ("GET", "/api/v2/template"): {"items": [], "total": 0},
        ("GET", f"/api/v2/layer/{ORG_DATASET['id']}"): {
            "id": ORG_DATASET["id"],
            "name": ORG_DATASET["name"],
            "type": "feature",
            "feature_layer_geometry_type": "point",
        },
    }


def _layer_routes(layer: FixtureLayer) -> dict[tuple[str, str], Any]:
    """geoapi's answers for one layer: its fields and its features."""
    queryables = {
        "properties": {
            name: {"name": name, "type": kind} for name, kind in layer.fields.items()
        }
    }
    queryables["properties"]["geom"] = {
        "$ref": "https://geojson.org/schema/Geometry.json"
    }

    def items(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        selected = _selected(layer, params.get("filter"))
        limit = int(params.get("limit", "10"))
        fields = params["properties"].split(",") if "properties" in params else None
        features = [
            {
                "type": "Feature",
                "id": index + 1,
                "geometry": _geometry(layer, feature["_at"]),
                "properties": _public(feature, fields),
            }
            for index, feature in enumerate(selected[:limit])
        ]
        return httpx.Response(
            200,
            json={
                "type": "FeatureCollection",
                "numberMatched": len(selected),
                "features": features,
            },
        )

    return {
        ("GET", f"/collections/{layer.layer_id}/queryables"): queryables,
        ("GET", f"/collections/{layer.layer_id}/items"): items,
    }


def _geoapi_routes() -> dict[tuple[str, str], Any]:
    routes: dict[tuple[str, str], Any] = {}
    for layer in _BY_ID.values():
        routes.update(_layer_routes(layer))
    return routes


def _bbox(layer: FixtureLayer, features: list[dict[str, Any]]) -> list[float]:
    lons = [f["_at"][0] for f in features] + [f["_at"][0] + 0.02 for f in features]
    lats = [f["_at"][1] for f in features] + [f["_at"][1] + 0.02 for f in features]
    return [min(lons), min(lats), max(lons), max(lats)]


def _process(
    name: str, layer: FixtureLayer, inputs: Mapping[str, Any]
) -> dict[str, Any]:
    selected = _selected(layer, inputs.get("filter"))
    attribute = inputs.get("attribute")
    values = [
        f[attribute] for f in selected if attribute and f.get(attribute) is not None
    ]
    if name == "feature-count":
        return {"count": len(selected)}
    if name == "unique-values":
        counted = Counter(values).most_common(int(inputs.get("limit", 50)))
        return {
            "attribute": attribute,
            "total": len(set(values)),
            "values": [{"value": value, "count": count} for value, count in counted],
        }
    if name == "class-breaks":
        numbers = sorted(float(v) for v in values)
        if not numbers:
            return {
                "attribute": attribute,
                "method": inputs.get("method"),
                "breaks": [],
                "min": None,
                "max": None,
                "mean": None,
                "std_dev": None,
            }
        # ``breaks`` internal points make ``breaks + 1`` classes (the service's contract).
        n = max(int(inputs.get("breaks", 5)), 2)
        if inputs.get("method") == "equal_interval":
            breaks = [
                numbers[0] + (numbers[-1] - numbers[0]) * k / (n + 1)
                for k in range(1, n + 1)
            ]
        else:
            breaks = [
                numbers[min(len(numbers) - 1, len(numbers) * k // (n + 1))]
                for k in range(1, n + 1)
            ]
        return {
            "attribute": attribute,
            "method": inputs.get("method"),
            "breaks": breaks,
            "min": numbers[0],
            "max": numbers[-1],
            "mean": statistics.fmean(numbers),
            "std_dev": statistics.pstdev(numbers),
        }
    if name == "area-statistics":
        operation = str(inputs["operation"])

        def area_of(features: list[dict[str, Any]]) -> dict[str, Any]:
            areas = [float(f.get("flaeche_m2", 0.0)) for f in features]
            stats = {
                "sum": sum(areas),
                "min": min(areas, default=None),
                "max": max(areas, default=None),
            }
            return {
                "result": stats[operation],
                "total_area": sum(areas),
                "feature_count": len(features),
            }

        group = inputs.get("group_by_column")
        groups: list[dict[str, Any]] = []
        if group:
            members: dict[str | None, list[dict[str, Any]]] = {}
            for feature in selected:
                value = feature.get(group)
                members.setdefault(None if value is None else str(value), []).append(
                    feature
                )
            # As the service orders them: largest total area first.
            groups = sorted(
                (
                    {"grouped_value": value, **area_of(features)}
                    for value, features in members.items()
                ),
                key=lambda row: row["total_area"],
                reverse=True,
            )
        return {
            **area_of(selected),
            "unit": "m²",
            "groups": groups[:100],
            "total_groups": len(groups) if group else None,
        }
    if name == "extent":
        return {
            "bbox": _bbox(layer, selected) if selected else None,
            "feature_count": len(selected),
        }
    if name == "aggregation-stats":
        group = inputs.get("group_by_column")
        then = inputs.get("group_by_secondary_column")
        column = inputs.get("operation_column")
        operation = str(inputs.get("operation", "count"))
        buckets: dict[tuple[Any, Any], list[float]] = {}
        for feature in selected:
            key = (
                feature.get(group) if group else None,
                feature.get(then) if then else None,
            )
            buckets.setdefault(key, []).append(
                float(feature.get(column) or 0) if column else 1.0
            )

        def value(numbers: list[float]) -> float:
            if operation == "count":
                return float(len(numbers))
            if operation == "sum":
                return sum(numbers)
            if operation == "mean":
                return statistics.fmean(numbers)
            return min(numbers) if operation == "min" else max(numbers)

        rows: list[dict[str, Any]] = [
            {
                "grouped_value": None if key[0] is None else str(key[0]),
                "grouped_secondary_value": None if key[1] is None else str(key[1]),
                "operation_value": value(numbers),
            }
            for key, numbers in buckets.items()
        ]
        items = sorted(
            rows,
            key=lambda item: item["operation_value"],
            reverse=inputs.get("order", "descendent") == "descendent",
        )
        return {
            "items": items[: int(inputs.get("limit", 100))],
            "total_items": len(items),
            "total_count": len(selected),
        }
    raise ValueError(name)


#: A layer id -> the layer, for the layers of one task (fixture layers and
#: the ones its catalog adds gave); None for a layer the fixture does not have.
LayerOf = Callable[[str], FixtureLayer | None]
#: The issue levels at which processes refuses a run (its ``BLOCKING_LEVELS``).
_BLOCKING_LEVELS = frozenset({"damaged", "error"})


def _fields_of(layer_of: LayerOf) -> Callable[[str], list[str] | None]:
    """A layer id -> its field names, for the layers of one task."""

    def fields(layer_id: str) -> list[str] | None:
        layer = layer_of(layer_id)
        return list(layer.fields) if layer is not None else None

    return fields


def _processes_routes(layer_of: LayerOf) -> dict[tuple[str, str], Any]:
    def answer(name: str) -> Any:
        def respond(request: httpx.Request) -> httpx.Response:
            inputs = json.loads(request.content)["inputs"]
            layer = layer_of(str(inputs["collection"]))
            if layer is None:
                return httpx.Response(404, json={"detail": "Layer not found"})
            return httpx.Response(200, json=_process(name, layer, inputs))

        return respond

    routes: dict[tuple[str, str], Any] = {
        ("POST", f"/processes/{name}/execution"): answer(name)
        for name in (
            "feature-count",
            "unique-values",
            "class-breaks",
            "area-statistics",
            "extent",
            "aggregation-stats",
        )
    }

    def listing(request: httpx.Request) -> httpx.Response:
        language = "de" if request.headers.get("accept-language") == "de" else "en"
        return httpx.Response(
            200, json={"processes": PROCESSES["list"][language], "links": []}
        )

    fields = _fields_of(layer_of)

    def check(request: httpx.Request) -> httpx.Response:
        issues = fixture_check(json.loads(request.content), fields)
        return httpx.Response(200, json={"issues": issues})

    routes[("GET", "/processes")] = listing
    for tool_id, described in PROCESSES["descriptions"].items():
        routes[("GET", f"/processes/{tool_id}")] = described
    routes[("POST", "/workflows/check")] = check
    return routes


def _run_routes(
    saved: list[dict[str, Any]], add_result: Callable[[str], None], layer_of: LayerOf
) -> dict[tuple[str, str], Any]:
    """Processes' runs for one task. As processes' execute does, a run first
    gets the workflow check (``fixture_check`` of the stored config, with the
    task's layer fields): a damaged or error issue refuses it with 422 and
    every issue, and nothing is submitted. Any other run of a workflow core
    saved finishes at once and saves RESULT_LAYER for each export step. Job
    ids are j-1, j-2, ... in the order runs start."""
    jobs: list[dict[str, Any]] = []
    fields = _fields_of(layer_of)

    def found(workflow_id: str) -> tuple[dict[str, Any], str] | None:
        if workflow_id == RUN_WORKFLOW_ID:
            return RUN_WORKFLOW["config"], RUN_PROJECT_ID
        row = next((row for row in saved if row["id"] == workflow_id), None)
        # A workflow made from a template is kept without a config, so the
        # check refuses its run as damaged.
        return (row.get("config") or {}, row["project_id"]) if row is not None else None

    def execute(workflow_id: str) -> Callable[[httpx.Request], httpx.Response]:
        def respond(request: httpx.Request) -> httpx.Response:
            workflow = found(workflow_id)
            if workflow is None:
                return httpx.Response(404, json={"detail": "Workflow not found"})
            config, project_id = workflow
            issues = fixture_check(config, fields)
            if any(issue["level"] in _BLOCKING_LEVELS for issue in issues):
                return httpx.Response(
                    422,
                    json={
                        "detail": {
                            "message": "The workflow has issues.",
                            "issues": issues,
                        }
                    },
                )
            job_id = f"j-{len(jobs) + 1}"
            at = f"2026-10-23T09:{len(jobs):02d}:00Z"
            job: dict[str, Any] = {
                "jobID": job_id,
                "processID": "workflow_runner",
                "inputs": {"workflow_id": workflow_id},
                "created": at,
                "started": at,
            }
            results: dict[str, Any] = {}
            for node in config.get("nodes") or []:
                data = node.get("data") or {}
                if data.get("type") == "tool":
                    results[node["id"]] = {
                        "status": "success",
                        "feature_count": len(RESULT_ROWS),
                    }
                elif data.get("type") == "export":
                    add_result(project_id)
                    results[node["id"]] = {
                        "layer_id": RESULT_LAYER.layer_id,
                        "layer_name": data.get("datasetName") or RESULT_LAYER.name,
                        "layer_project_id": RESULT_LAYER.layer_project_id,
                        "feature_count": len(RESULT_ROWS),
                    }
            job.update(
                status="successful",
                result={
                    "status": "success",
                    "errors": [],
                    "node_jobs": {},
                    "node_results": results,
                },
            )
            jobs.append(job)
            return httpx.Response(
                200,
                json={
                    "job_id": job_id,
                    "workflow_id": workflow_id,
                    "status": "submitted",
                },
            )

        return respond

    def status(job_id: str) -> Callable[[httpx.Request], httpx.Response]:
        def respond(request: httpx.Request) -> httpx.Response:
            job = next((job for job in jobs if job["jobID"] == job_id), None)
            if job is None:
                return httpx.Response(404, json={"detail": "Job not found"})
            return httpx.Response(200, json=job)

        return respond

    routes: dict[tuple[str, str], Any] = {
        ("GET", "/jobs"): lambda request: httpx.Response(
            200, json={"jobs": list(reversed(jobs))}
        ),
    }
    for workflow_id in (
        RUN_WORKFLOW_ID,
        *(f"0b6f0000-0000-0000-0000-{n:012d}" for n in range(1, 6)),
    ):
        routes[("POST", f"/workflows/{workflow_id}/execute")] = execute(workflow_id)
    for n in range(1, 6):
        routes[("GET", f"/jobs/j-{n}")] = status(f"j-{n}")
        routes[("DELETE", f"/jobs/j-{n}")] = {"status": "dismissed"}
    return routes


PROCESSES: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "fixtures"
        / "process_descriptions.json"
    ).read_text(encoding="utf-8")
)

# ---- the stand-in for processes' workflow check ------------------------------
#
# It follows processes' `services/workflow_checks.py` step by step, with the
# descriptions captured from processes, the tools' own parameter models
# (`goatlib.tools.registry`) and the arguments a run would build
# (`goatlib.tools.workflow_arguments`). What it leaves out: the access check
# (the fixture's layers are all readable), the columns predicted for a step
# that reads another tool's result (processes warns about them), except a
# join's right before a step, which it predicts with goatlib's join runner to
# find a field the join renamed; a join further up is left out. Also left
# out: If steps (drafts have none) and the `step_not_connected` warning. A
# draft's notes (`textAnnotation`) it skips, as processes does.

#: Layer id -> its field names; None for a layer whose fields are not known.
LayerFields = Callable[[str], Sequence[str] | None]
#: The input the runner feeds from a connection that names none.
_DEFAULT_HANDLE = "input_layer_id"
#: The editor's handle on a step whose tool it has not loaded yet.
_EDITOR_HANDLE = "input"
#: What the editor's form holds for a connected layer input.
_CONNECTED = "__connected__"
_FIELD_WIDGET = "field-selector"
_FIELD_STATISTICS_WIDGET = "field-statistics-selector"
#: Pydantic puts the kind of a validator's error before its text.
_VALIDATOR_PREFIXES = ("Value error, ", "Assertion failed, ")
#: Columns that hold the geometry, not a field.
_GEOMETRY_COLUMNS = frozenset({"geometry", "geom", "bbox"})
#: A heatmap's numbered opportunity handles, the names of
#: ``goatlib.tools._opportunity_handles.NUMBERED_OPPORTUNITY_ID_FIELDS``. That
#: module imports goatlib's analysis package, so it is not imported here; a
#: test keeps the two equal.
OPPORTUNITY_HANDLES: tuple[str, ...] = (
    "opportunity_layer_1_id",
    "opportunity_layer_2_id",
    "opportunity_layer_3_id",
)


def _fixture_fields(layer_id: str) -> list[str] | None:
    layer = _BY_ID.get(layer_id)
    return list(layer.fields) if layer is not None else None


def _data(node: Mapping[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    return data if isinstance(data, dict) else {}


def _kind(node: Mapping[str, Any]) -> str:
    return str(_data(node).get("type") or node.get("type") or "")


def _schema(entry: Mapping[str, Any]) -> dict[str, Any]:
    schema = entry.get("schema")
    return schema if isinstance(schema, dict) else {}


def _variant(schema: Mapping[str, Any]) -> dict[str, Any] | None:
    """The non-null variant of an optional type."""
    return next(
        (
            variant
            for variant in schema.get("anyOf") or []
            if isinstance(variant, dict) and variant.get("type") != "null"
        ),
        None,
    )


def _ui(schema: Mapping[str, Any]) -> dict[str, Any]:
    """A setting's x-ui, also when it sits on the non-null variant."""
    ui = schema.get("x-ui")
    if ui is None:
        variant = _variant(schema)
        ui = variant.get("x-ui") if variant else None
    return ui if isinstance(ui, dict) else {}


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == []


def _is_field_widget(name: str, ui: Mapping[str, Any]) -> bool:
    widget = ui.get("widget")
    return widget == _FIELD_WIDGET or (not widget and name.endswith("_field"))


def _declared_source(ui: Mapping[str, Any]) -> str | None:
    """The layer input a field setting's widget names (``source_layer``),
    without a path into it (``starting_points.layer_id``)."""
    options = ui.get("widget_options")
    declared = options.get("source_layer") if isinstance(options, dict) else None
    return declared.split(".")[0] if isinstance(declared, str) else None


def _item_properties(
    schema: Mapping[str, Any], defs: Mapping[str, Any]
) -> dict[str, Any] | None:
    items = schema.get("items")
    if not isinstance(items, dict):
        return None
    ref = items.get("$ref")
    item = defs.get(ref.removeprefix("#/$defs/"), {}) if isinstance(ref, str) else items
    properties = item.get("properties") if isinstance(item, dict) else None
    return properties if isinstance(properties, dict) else None


def _variable_names(value: Any) -> list[str]:
    """Every ``{{@name}}`` reference in a value, at any depth."""
    if isinstance(value, str):
        return [str(name) for name in VARIABLE_PATTERN.findall(value)]
    if isinstance(value, dict):
        return [name for item in value.values() for name in _variable_names(item)]
    if isinstance(value, list):
        return [name for item in value for name in _variable_names(item)]
    return []


def _resolved(field: str, var_map: Mapping[str, Any]) -> str | None:
    """A field setting's value with its variables resolved, as a run would."""
    if not VARIABLE_PATTERN.search(field):
        return field
    try:
        resolved = resolve_variables(field, dict(var_map))
    except ValueError:
        return None
    return resolved if isinstance(resolved, str) and resolved else None


@dataclass(frozen=True)
class _FieldRef:
    """One field name a step's settings point at."""

    setting: str
    label: str
    field: str
    #: The layer input it is read from, when known.
    source: str | None


def _field_refs(
    described: Mapping[str, Any],
    config: Mapping[str, Any],
    handles: set[str],
    layer_inputs: Sequence[str],
) -> list[_FieldRef]:
    """Every field name a tool step's settings point at, and the layer input
    each is read from, as processes' ``_field_refs`` reads them: a field
    inside a list item reads the input its own widget names first
    (``column_statistics[].field`` reads ``source_layer_id``), else the list
    setting's."""
    inputs: dict[str, Any] = described["inputs"]
    defs: dict[str, Any] = described.get("$defs") or {}
    sole = layer_inputs[0] if len(layer_inputs) == 1 else None

    def source_for(name: str, ui: Mapping[str, Any]) -> str | None:
        declared = _declared_source(ui)
        if declared is not None:
            return declared
        if name.endswith("_field"):
            return f"{name.removesuffix('_field')}_layer_id"
        return sole

    refs: list[_FieldRef] = []
    for name, entry in inputs.items():
        schema = _schema(entry)
        ui = _ui(schema)
        label = str(entry.get("title") or name)
        value = config.get(name)
        if ui.get("widget") == _FIELD_STATISTICS_WIDGET:
            for item in value if isinstance(value, list) else [value]:
                field = item.get("field") if isinstance(item, dict) else None
                if isinstance(field, str) and field:
                    refs.append(_FieldRef(name, label, field, source_for(name, ui)))
            continue
        if _is_field_widget(name, ui):
            for field in value if isinstance(value, list) else [value]:
                if isinstance(field, str) and field:
                    refs.append(_FieldRef(name, label, field, source_for(name, ui)))
            continue
        effective = _variant(schema) or schema
        properties = _item_properties(effective, defs)
        if effective.get("type") != "array" or properties is None:
            continue
        if name == OPPORTUNITIES:
            for number, handle in enumerate(OPPORTUNITY_HANDLES, start=1):
                if handle not in handles:
                    continue
                for prop, prop_schema in properties.items():
                    field = config.get(f"opportunity_{number}_{prop}")
                    prop_ui = _ui(prop_schema)
                    if (
                        _is_field_widget(prop, prop_ui)
                        and isinstance(field, str)
                        and field
                    ):
                        refs.append(
                            _FieldRef(
                                f"opportunity_{number}_{prop}",
                                f"{label} {number} · {prop_ui.get('label') or prop}",
                                field,
                                handle,
                            )
                        )
        if not isinstance(value, list):
            continue
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            for prop, prop_schema in properties.items():
                prop_ui = _ui(prop_schema)
                field = item.get(prop)
                if not _is_field_widget(prop, prop_ui) or not isinstance(field, str):
                    continue
                if not field:
                    continue
                if name == OPPORTUNITIES:
                    numbered = OPPORTUNITY_HANDLES
                    source = numbered[index] if index < len(numbered) else None
                else:
                    source = _declared_source(prop_ui) or source_for(name, ui)
                prop_label = prop_ui.get("label") or prop
                refs.append(_FieldRef(name, f"{label} · {prop_label}", field, source))
    return refs


def _source_node(
    incoming: Sequence[Mapping[str, Any]],
    source_input: str | None,
    by_id: Mapping[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """The step connected to ``source_input`` (processes' ``_source_for``)."""
    if source_input:
        exact = next(
            (edge for edge in incoming if edge.get("targetHandle") == source_input),
            None,
        )
        if exact is not None:
            return by_id.get(str(exact["source"]))
    unnamed = [
        edge
        for edge in incoming
        if not edge.get("targetHandle") or edge.get("targetHandle") == _EDITOR_HANDLE
    ]
    if len(unnamed) == 1:
        return by_id.get(str(unnamed[0]["source"]))
    if not source_input and len(incoming) == 1:
        return by_id.get(str(incoming[0]["source"]))
    return None


def _reason(message: str) -> str:
    for prefix in _VALIDATOR_PREFIXES:
        if message.startswith(prefix):
            return message[len(prefix) :]
    return message


class _StepCheck:
    """The issues of one tool step, in the order processes reports them."""

    def __init__(
        self,
        node: dict[str, Any],
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        variables: list[dict[str, Any]],
        incoming: list[dict[str, Any]],
        by_id: Mapping[str, dict[str, Any]],
        fields: LayerFields,
    ) -> None:
        self.node, self.nodes, self.edges = node, nodes, edges
        self.variables, self.incoming, self.by_id = variables, incoming, by_id
        self.fields = fields
        self.node_id = str(node["id"])
        self.var_map = variable_map(variables)

    def issue(
        self, code: str, message: str, field: str | None = None, **params: Any
    ) -> Issue:
        return Issue(code, "error", message, (self.node_id,), field, params)

    def run(self, step: str) -> list[Issue]:
        data = _data(self.node)
        process_id = data.get("processId")
        if not isinstance(process_id, str) or not process_id.strip():
            return [
                self.issue("tool_missing", f"{step}: no tool is chosen.", step=step)
            ]
        described = PROCESSES["descriptions"].get(process_id)
        if described is None:
            return [
                self.issue(
                    "tool_removed",
                    f"{step}: the tool {process_id} does not exist.",
                    step=step,
                    tool=process_id,
                )
            ]
        inputs: dict[str, Any] = described["inputs"]
        raw_config = data.get("config")
        config: dict[str, Any] = raw_config if isinstance(raw_config, dict) else {}
        handles = {
            str(edge.get("targetHandle") or _DEFAULT_HANDLE) for edge in self.incoming
        }
        layer_inputs = {
            name: entry
            for name, entry in inputs.items()
            if _ui(_schema(entry)).get("widget") in LAYER_WIDGETS
        }
        values = self.values(inputs, layer_inputs, config, handles)
        issues: list[Issue] = []
        named = [edge.get("targetHandle") for edge in self.incoming]
        for handle in dict.fromkeys(h for h in named if isinstance(h, str) and h):
            if handle not in layer_inputs and handle != _EDITOR_HANDLE:
                issues.append(
                    self.issue(
                        "connection_to_unknown_input",
                        f"{step}: a connection ends at {handle}, which the tool "
                        "does not have.",
                        handle,
                        step=step,
                        input=handle,
                    )
                )
        for name, entry in layer_inputs.items():
            if int(entry.get("minOccurs") or 0) > 0 and name not in handles:
                label = str(entry.get("title") or name)
                issues.append(
                    self.issue(
                        "input_not_connected",
                        f"{step}: {label} is not connected.",
                        name,
                        step=step,
                        label=label,
                    )
                )
        numbered = [h for h in OPPORTUNITY_HANDLES if h in inputs]
        if numbered and not handles & set(numbered):
            issues.append(
                self.issue(
                    "opportunity_not_connected",
                    f"{step}: no opportunity layer is connected.",
                    step=step,
                )
            )
        for name, entry in inputs.items():
            ui = _ui(_schema(entry))
            if (
                ui.get("widget") in NOT_SETTING_WIDGETS
                or ui.get("section") in NOT_SETTING_SECTIONS
            ):
                continue
            required = int(entry.get("minOccurs") or 0) > 0
            if required and is_shown(ui, values) and _is_empty(config.get(name)):
                label = str(entry.get("title") or name)
                issues.append(
                    self.issue(
                        "setting_required",
                        f"{step}: {label} is required.",
                        name,
                        step=step,
                        label=label,
                    )
                )
        for setting, value in config.items():
            for name in dict.fromkeys(_variable_names(value)):
                if name not in self.var_map:
                    issues.append(
                        self.issue(
                            "variable_undefined",
                            f"{step}: the variable {name} does not exist.",
                            setting,
                            step=step,
                            variable=name,
                        )
                    )
        issues += self.invalid_settings(step, process_id, described, values, issues)
        issues += self.field_issues(step, described, config, values, handles)
        return issues

    def values(
        self,
        inputs: Mapping[str, Any],
        layer_inputs: Mapping[str, Any],
        config: Mapping[str, Any],
        handles: set[str],
    ) -> dict[str, Any]:
        """What the editor's form decides visibility on: the defaults, the
        settings, and a marker in every connected layer input."""
        values = {
            name: _schema(entry)["default"]
            for name, entry in inputs.items()
            if "default" in _schema(entry)
        }
        values.update(config)
        for name, entry in layer_inputs.items():
            if name in handles:
                points = _ui(_schema(entry)).get("widget") == "starting-points"
                values[name] = {"layer_id": _CONNECTED} if points else _CONNECTED
        return values

    def invalid_settings(
        self,
        step: str,
        process_id: str,
        described: Mapping[str, Any],
        values: Mapping[str, Any],
        issues: list[Issue],
    ) -> list[Issue]:
        """``setting_invalid``: what the tool's parameter model rejects in the
        arguments a run would build, without the settings already reported
        and the missing values of settings the form hides."""
        tool = get_tool(process_id)
        try:
            arguments = build_check_arguments(
                self.node, self.nodes, self.edges, self.variables
            )
            if tool is None:
                return []
            tool.get_params_class()(**arguments)
            return []
        except ValidationError as error:
            errors = error.errors(include_url=False)
        except Exception:  # a missing variable, reported on its own
            return []
        inputs: dict[str, Any] = described["inputs"]
        reported = {
            issue.field
            for issue in issues
            if issue.field is not None
            and issue.code
            in ("input_not_connected", "setting_required", "variable_undefined")
        }
        if any(issue.code == "opportunity_not_connected" for issue in issues):
            reported.add(OPPORTUNITIES)
        hidden = {
            name
            for name, entry in inputs.items()
            if not is_shown(_ui(_schema(entry)), dict(values))
        }
        found: list[Issue] = []
        seen: set[tuple[str | None, str]] = set()
        for problem in errors:
            loc = tuple(problem.get("loc") or ())
            name = loc[0] if loc and isinstance(loc[0], str) else None
            if name in reported or (
                problem.get("type") == "missing" and name in hidden
            ):
                continue
            field, label = self.invalid_setting(described, name, loc)
            reason = _reason(str(problem.get("msg", "")))
            key = (field, "") if field is not None else (None, reason)
            if key in seen:
                continue
            seen.add(key)
            message = (
                f"{step}: {label}: {reason}"
                if field is not None
                else f"{step}: {reason}"
            )
            found.append(
                self.issue(
                    "setting_invalid",
                    message,
                    field,
                    step=step,
                    label=label,
                    reason=reason,
                )
            )
        return found

    def invalid_setting(
        self, described: Mapping[str, Any], name: str | None, loc: tuple[Any, ...]
    ) -> tuple[str | None, str]:
        """The setting a parameter error belongs to, and its label: an
        opportunity's settings are ``opportunity_<N>_<name>`` on the step."""
        inputs: dict[str, Any] = described["inputs"]
        if (
            name == OPPORTUNITIES
            and len(loc) >= 3
            and isinstance(loc[1], int)
            and isinstance(loc[2], str)
        ):
            handles = {str(edge.get("targetHandle")) for edge in self.incoming}
            numbers = [
                number
                for number, handle in enumerate(OPPORTUNITY_HANDLES, start=1)
                if handle in handles
            ]
            if loc[1] < len(numbers):
                number, prop = numbers[loc[1]], loc[2]
                schema = _schema(inputs[OPPORTUNITIES])
                properties = (
                    _item_properties(
                        _variant(schema) or schema, described.get("$defs") or {}
                    )
                    or {}
                )
                prop_schema = properties.get(prop) or {}
                prop_label = (
                    _ui(prop_schema).get("label") or prop_schema.get("title") or prop
                )
                title = str(inputs[OPPORTUNITIES].get("title") or OPPORTUNITIES)
                return (
                    f"opportunity_{number}_{prop}",
                    f"{title} {number} · {prop_label}",
                )
        if name is not None and name in inputs:
            return name, str(inputs[name].get("title") or name)
        return None, ""

    def _joined_columns(self, join: Mapping[str, Any]) -> set[str] | None:
        """The columns a join step writes when both its inputs are datasets
        with known fields (goatlib's ``predict_output_schema`` of the join
        runner, with the tool's defaults under the step's settings); None for
        any other step, and for settings the prediction fails on, which
        leave the step after it unjudged, as in processes
        (``predict_node_output_schema``)."""
        data = _data(join)
        if data.get("processId") != "join":
            return None
        schemas: dict[str, dict[str, str]] = {}
        for edge in self.edges:
            if str(edge.get("target")) != str(join["id"]):
                continue
            source = self.by_id.get(str(edge.get("source")))
            layer_id = _data(source).get("layerId") if source is not None else None
            known = self.fields(layer_id) if isinstance(layer_id, str) else None
            if known is None:
                return None
            schemas[str(edge.get("targetHandle"))] = dict.fromkeys(known, "VARCHAR")
        if set(schemas) != {"target_layer_id", "join_layer_id"}:
            return None
        described = PROCESSES["descriptions"]["join"]["inputs"]
        defaults = {
            name: _schema(entry)["default"]
            for name, entry in described.items()
            if "default" in _schema(entry)
        }
        settings = {**defaults, **(data.get("config") or {})}
        runner = get_tool("join").get_runner_class()
        if runner is None:
            return None
        try:
            return set(runner.predict_output_schema(schemas, settings))
        except Exception:
            return None

    def field_issues(
        self,
        step: str,
        described: Mapping[str, Any],
        config: Mapping[str, Any],
        values: Mapping[str, Any],
        handles: set[str],
    ) -> list[Issue]:
        """``field_not_in_layer``: a field setting naming a field that the
        dataset it reads does not have. ``field_renamed_by_join``: one that
        the join step right before writes only as ``join_<field>``, its
        columns predicted by goatlib's join runner from two datasets. Nothing
        else is judged: an open step has no fields yet, and processes only
        warns about a field read from any other tool's result."""
        inputs: dict[str, Any] = described["inputs"]
        layer_inputs = [
            name
            for name, entry in inputs.items()
            if _ui(_schema(entry)).get("widget") in LAYER_WIDGETS
        ]
        found: list[Issue] = []
        for ref in _field_refs(described, config, handles, layer_inputs):
            entry = inputs.get(ref.setting)
            if entry is not None and not is_shown(_ui(_schema(entry)), dict(values)):
                continue
            name = _resolved(ref.field, self.var_map)
            origin = _source_node(self.incoming, ref.source, self.by_id)
            if name is None or origin is None:
                continue
            if _kind(origin) == "tool":
                joined = f"join_{name}"
                columns = self._joined_columns(origin)
                if columns is None or name in columns or joined not in columns:
                    continue
                found.append(
                    self.issue(
                        "field_renamed_by_join",
                        f"{step}: {ref.label} names the field {name}, which the "
                        f"step before does not produce: the join names it {joined}.",
                        ref.setting,
                        step=step,
                        label=ref.label,
                        field_name=name,
                        joined_field=joined,
                    )
                )
                continue
            if _kind(origin) != "dataset":
                continue
            layer_id = _data(origin).get("layerId")
            known = self.fields(layer_id) if isinstance(layer_id, str) else None
            if known is None or name in known:
                continue
            found.append(
                self.issue(
                    "field_not_in_layer",
                    f"{step}: {ref.label} names the field {name}, which the layer "
                    "does not have.",
                    ref.setting,
                    step=step,
                    label=ref.label,
                    field_name=name,
                )
            )
        return found


def _step_name(node: Mapping[str, Any]) -> str:
    """The name a person sees on a step, as processes names it: a tool step
    labelled with its tool's id goes by the tool's title."""
    data = _data(node)
    label = data.get("label")
    named = isinstance(label, str) and bool(label.strip())
    if _kind(node) != "tool":
        return str(label) if named else _kind(node)
    process_id = data.get("processId")
    if named and label != process_id:
        return str(label)
    described = PROCESSES["descriptions"].get(str(process_id))
    if described is not None:
        return str(described.get("title") or process_id)
    return str(label) if named else "tool"


def fixture_check(
    body: Mapping[str, Any], fields: LayerFields = _fixture_fields
) -> list[dict[str, Any]]:
    """The stand-in for processes' workflow check (see above): the issues of
    the steps and connections in ``body``, as ``Issue.to_dict()`` rows.
    ``fields`` gives a layer's field names by layer id."""
    damaged = shape_issues({"nodes": body.get("nodes"), "edges": body.get("edges")})
    if damaged:
        return [issue.to_dict() for issue in damaged]
    nodes: list[dict[str, Any]] = body["nodes"]
    edges: list[dict[str, Any]] = body["edges"]
    raw_variables = body.get("variables")
    variables: list[dict[str, Any]] = (
        raw_variables if isinstance(raw_variables, list) else []
    )
    by_id = {str(node["id"]): node for node in nodes}
    incoming: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in by_id}
    for edge in edges:
        source, target = edge.get("source"), edge.get("target")
        if source in by_id and target in by_id:
            incoming[str(target)].append(edge)
    issues: list[Issue] = []
    for loop in find_loops(nodes, edges):
        names = [_step_name(by_id[node_id]) for node_id in loop]
        issues.append(
            Issue(
                "loop",
                "error",
                f"These steps form a loop: {', '.join(names)}.",
                tuple(loop),
                params={"steps": names},
            )
        )
    if dangling_edges(nodes, edges):
        issues.append(
            Issue(
                "connection_to_removed_step",
                "error",
                "A connection points to a step that does not exist.",
            )
        )
    for node in nodes:
        node_id, kind, step = str(node["id"]), _kind(node), _step_name(node)
        data = _data(node)
        if kind == "dataset" and (
            data.get("unresolved") is True or not data.get("layerId")
        ):
            issues.append(
                Issue(
                    "layer_not_chosen",
                    "error",
                    f"{step}: no layer is chosen.",
                    (node_id,),
                    params={"step": step},
                )
            )
        elif kind == "export" and not incoming[node_id]:
            issues.append(
                Issue(
                    "export_not_connected",
                    "warning",
                    f"{step}: nothing is connected to it.",
                    (node_id,),
                    params={"step": step},
                )
            )
        elif kind == "export" and data.get("destination") == "existing":
            # Adds the rows to an existing dataset: no name to judge, only
            # that dataset.
            if not data.get("targetLayerId"):
                issues.append(
                    Issue(
                        "export_target_missing",
                        "error",
                        f"{step}: the dataset to add the rows to is not chosen.",
                        (node_id,),
                        "targetLayerId",
                        {"step": step},
                    )
                )
        elif kind == "export" and not str(data.get("datasetName") or "").strip():
            issues.append(
                Issue(
                    "export_name_missing",
                    "error",
                    f"{step}: the dataset name is missing.",
                    (node_id,),
                    "datasetName",
                    {"step": step},
                )
            )
        elif kind == "tool":
            issues += _StepCheck(
                node, nodes, edges, variables, incoming[node_id], by_id, fields
            ).run(step)
    return [issue.to_dict() for issue in issues]


def _layer_rows(layers: Iterable[FixtureLayer]) -> list[dict[str, Any]]:
    return [
        {
            "id": layer.layer_project_id,
            "layer_id": layer.layer_id,
            "name": layer.name,
            "type": layer.layer_type,
            "feature_layer_geometry_type": layer.geometry or None,
            "layer_project_group_id": None,
            "order": order,
            "locked": layer.locked,
        }
        for order, layer in enumerate(layers)
    ]


#: The first layer_project_id of a catalog dataset added in a task, after
#: the fixed ones of ``CATALOG_LAYERS``.
_FIRST_ADDED_LAYER = 43


def _catalog_layer(item: Mapping[str, Any], layer_project_id: int) -> FixtureLayer:
    """The layer adding a catalog item gives: the item's title and geometry
    type, and as its fields the columns its record lists (without the
    geometry), so the record and geoapi name the same fields. It has no
    features: its data would still be copying."""
    props = item.get("properties") or {}
    columns = [
        column
        for column in props.get("table:columns") or []
        if isinstance(column, dict)
        and isinstance(column.get("name"), str)
        and column["name"] not in _GEOMETRY_COLUMNS
    ]
    geometry = str(props.get("goat:geometryType") or "")
    return FixtureLayer(
        layer_project_id,
        str(uuid.uuid5(uuid.NAMESPACE_URL, f"eval-catalog:{item['id']}")),
        str(props.get("title") or item["id"]),
        geometry,
        {
            str(column["name"]): str(column.get("type") or "string")
            for column in columns
        },
        (),
        layer_type="feature" if geometry else "table",
    )


def _workflow_core_routes(
    catalog: FastAPI,
    register: Callable[[FixtureLayer], None],
    saved: list[dict[str, Any]],
    results: dict[str, list[FixtureLayer]],
) -> dict[tuple[str, str], Any]:
    """Core for the workflow suite's projects, fresh for each task: adding a
    catalog dataset or the user's own (``ORG_DATASET``) puts its layers into
    the project's list (and geoapi's, through ``register``), and every
    workflow core saves goes into ``saved``, where the graders read it.
    ``results`` holds, by project id, the layers the task's runs saved, which
    the project's list ends with."""
    layers: dict[str, list[FixtureLayer]] = {
        WF_PROJECT_ID: list(WORKFLOW_LAYERS),
        VIEWER_PROJECT_ID: list(WORKFLOW_LAYERS),
        EMPTY_PROJECT_ID: [],
        RUN_PROJECT_ID: list(WORKFLOW_LAYERS),
    }
    names = {
        WF_PROJECT_ID: WF_PROJECT_NAME,
        VIEWER_PROJECT_ID: WF_PROJECT_NAME,
        EMPTY_PROJECT_ID: EMPTY_PROJECT_NAME,
        RUN_PROJECT_ID: RUN_PROJECT_NAME,
    }
    #: Catalog item id -> the layer adding it gave in this task.
    added: dict[str, FixtureLayer] = {}

    async def catalog_layers(catalog_id: str) -> list[FixtureLayer]:
        """The layers adding a catalog id gives, as core resolves it: an
        item's layer, or every layer of a dataset (``src-<item id>`` for the
        named rows)."""
        known = CATALOG_LAYERS.get(catalog_id.removeprefix("src-"))
        if known is not None:
            return [known]
        transport = httpx.ASGITransport(app=catalog)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://catalog"
        ) as client:
            response = await client.get(f"/stac/resolve/{quote(catalog_id, safe='')}")
        if response.status_code != 200:
            return []
        resolved = response.json()
        items = (
            [resolved.get("item")]
            if resolved.get("kind") == "item"
            else resolved.get("items") or []
        )
        found: list[FixtureLayer] = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            if item["id"] not in added:
                layer = _catalog_layer(item, _FIRST_ADDED_LAYER + len(added))
                added[item["id"]] = layer
                register(layer)
            found.append(added[item["id"]])
        return found

    def layer_list(project_id: str) -> Callable[[httpx.Request], httpx.Response]:
        def respond(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json=_layer_rows([*layers[project_id], *results.get(project_id, [])]),
            )

        return respond

    def add_catalog(project_id: str) -> Any:
        async def respond(request: httpx.Request) -> httpx.Response:
            if project_id == VIEWER_PROJECT_ID:
                return httpx.Response(
                    403,
                    json={
                        "detail": "Adding layers to a project requires editor access"
                    },
                )
            found = await catalog_layers(request.url.params.get("catalog_ids", ""))
            if not found:
                return httpx.Response(404, json={"detail": "Catalog item not found"})
            for layer in found:
                if layer not in layers[project_id]:
                    layers[project_id].append(layer)
            return httpx.Response(200, json=_layer_rows(found))

        return respond

    def add_layers(project_id: str) -> Callable[[httpx.Request], httpx.Response]:
        """Core's link of existing datasets: the fixture has one the user can
        read, ``ORG_DATASET``."""

        def respond(request: httpx.Request) -> httpx.Response:
            if project_id == VIEWER_PROJECT_ID:
                return httpx.Response(
                    403,
                    json={
                        "detail": "Adding layers to a project requires editor access"
                    },
                )
            layer = ORG_DATASET_LAYER
            if request.url.params.get_list("layer_ids") != [layer.layer_id]:
                return httpx.Response(
                    404, json={"detail": "One or several Layers were not found"}
                )
            register(layer)
            if layer not in layers[project_id]:
                layers[project_id].append(layer)
            return httpx.Response(200, json=_layer_rows([layer]))

        return respond

    def keep(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        workflow_id = f"0b6f0000-0000-0000-0000-{len(saved) + 1:012d}"
        saved.append({**body, "id": workflow_id, "project_id": project_id})
        return saved[-1]

    def create(project_id: str) -> Callable[[httpx.Request], httpx.Response]:
        def respond(request: httpx.Request) -> httpx.Response:
            if project_id == VIEWER_PROJECT_ID:
                # Core answers 401 for missing rights.
                return httpx.Response(401, json={"detail": "Unauthorized"})
            return httpx.Response(
                201, json=keep(project_id, json.loads(request.content))
            )

        return respond

    def templates(request: httpx.Request) -> httpx.Response:
        # As core searches (``crud_template``): the whole search text,
        # case-insensitive, in the name or the description.
        search = request.url.params.get("search", "").casefold()
        hit = request.url.params.get("kind") in (None, "workflow") and (
            search in str(TEMPLATE["name"]).casefold()
            or search in str(TEMPLATE["description"]).casefold()
        )
        return httpx.Response(
            200, json={"items": [TEMPLATE] if hit else [], "total": int(hit)}
        )

    def use(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        project_id = str(body.get("project_id"))
        if project_id not in layers or project_id == VIEWER_PROJECT_ID:
            return httpx.Response(401, json={"detail": "Unauthorized"})
        bound = body.get("bindings") or {}
        # Kept as core got them (input key -> layer id): the graders read
        # which layers the template's inputs were bound to.
        workflow = keep(
            project_id,
            {"name": body.get("name") or TEMPLATE["name"], "bindings": dict(bound)},
        )
        return httpx.Response(
            200,
            json={
                "project_id": project_id,
                "workflow_id": workflow["id"],
                "added_layer_project_ids": [],
                "unresolved_inputs": [
                    item for item in TEMPLATE["inputs"] if item["key"] not in bound
                ],
                "copy_jobs": [],
            },
        )

    def preview(request: httpx.Request) -> httpx.Response:
        # As core binds the template for a use, without writing: a bound
        # input reads its layer, through the project's entry of it.
        body = json.loads(request.content)
        project_id = str(body.get("project_id"))
        if project_id not in layers or project_id == VIEWER_PROJECT_ID:
            return httpx.Response(401, json={"detail": "Unauthorized"})
        bound = body.get("bindings") or {}
        config = json.loads(json.dumps(TEMPLATE_CONFIG))
        for node in config["nodes"]:
            key = node["data"].get("templateInput")
            if key in bound:
                node["data"].pop("unresolved", None)
                node["data"]["layerId"] = bound[key]
                entry = layer_project_id(bound[key])
                if entry is not None:
                    node["data"]["projectLayerId"] = entry
        return httpx.Response(
            200,
            json={
                "config": config,
                "unresolved_inputs": [
                    item for item in TEMPLATE["inputs"] if item["key"] not in bound
                ],
            },
        )

    def workflow(workflow_id: str) -> Callable[[httpx.Request], httpx.Response]:
        def respond(request: httpx.Request) -> httpx.Response:
            row = next((row for row in saved if row["id"] == workflow_id), None)
            if row is None:
                return httpx.Response(404, json={"detail": "Workflow not found"})
            return httpx.Response(200, json=row)

        return respond

    routes: dict[tuple[str, str], Any] = {
        ("GET", "/api/v2/template"): templates,
        # workflow_create_from_template reads the template before it uses it.
        ("GET", f"/api/v2/template/{TEMPLATE_ID}"): TEMPLATE,
        ("POST", f"/api/v2/template/{TEMPLATE_ID}/use/preview"): preview,
        ("POST", f"/api/v2/template/{TEMPLATE_ID}/use"): use,
    }
    for project_id, name in names.items():
        base = f"/api/v2/project/{project_id}"
        routes[("GET", base)] = {"id": project_id, "name": name, "folder_id": FOLDER_ID}
        routes[("GET", f"{base}/layer")] = layer_list(project_id)
        routes[("GET", f"{base}/group")] = []
        routes[("GET", f"{base}/workflow")] = []
        routes[("GET", f"{base}/report-layout")] = []
        routes[("POST", f"{base}/workflow")] = create(project_id)
        routes[("POST", f"{base}/layer-catalog")] = add_catalog(project_id)
        routes[("POST", f"{base}/layer")] = add_layers(project_id)
        # The ids keep() gives, in order: a task creates a few at most.
        for n in range(1, 6):
            workflow_id = f"0b6f0000-0000-0000-0000-{n:012d}"
            routes[("GET", f"{base}/workflow/{workflow_id}")] = workflow(workflow_id)
    run_base = f"/api/v2/project/{RUN_PROJECT_ID}"
    routes[("GET", f"{run_base}/workflow")] = [RUN_WORKFLOW]
    routes[("GET", f"{run_base}/workflow/{RUN_WORKFLOW_ID}")] = RUN_WORKFLOW
    return routes


class _Processes(Recorder):
    """Processes' routes; a tool without a description answers 404, as
    processes does for a tool it does not know. Its toolbox (``GET
    /processes``) lists the fixture's tools only, so a draft naming another
    tool is refused before the check."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        response = super().__call__(request)
        if (
            response.status_code == 599
            and request.method == "GET"
            and re.fullmatch(r"/processes/[^/]+", request.url.path)
        ):
            return httpx.Response(404, json={"detail": "Process not found"})
        return response


class _Core(Recorder):
    """Core's routes; a dataset or a bundle it does not have answers 404, as
    core does, so a card that adds an id no dataset has is refused as it
    would be."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        # Checked before the routes answer: some answer with a coroutine.
        if (
            request.method == "GET"
            and ("GET", request.url.path) not in self.routes
            and re.fullmatch(
                r"/api/v2/(layer/[^/]+|bundle/[^/]+/layers)", request.url.path
            )
        ):
            self.requests.append(request)
            return httpx.Response(404, json={"detail": "Not found"})
        return super().__call__(request)


class Backends:
    """One eval run's backends; ``clients()`` gives each task fresh recorders."""

    def __init__(self, catalog_dir: Path) -> None:
        self.catalog = catalog_app(catalog_dir)

    def close(self) -> None:
        """Close the catalog's DuckDB connection (the app's lifespan never runs)."""
        self.catalog.state.store.snapshot().con.close()

    def clients(
        self,
    ) -> tuple[ServiceClients, dict[str, list[httpx.Request]], list[dict[str, Any]]]:
        """Fresh services for one task, the requests they get, and the
        workflows core saves while the task runs."""
        geoapi = Recorder(_geoapi_routes())
        added: dict[str, FixtureLayer] = {}
        saved: list[dict[str, Any]] = []
        results: dict[str, list[FixtureLayer]] = {}

        def register(layer: FixtureLayer) -> None:
            added[layer.layer_id] = layer
            geoapi.routes.update(_layer_routes(layer))

        def layer_of(layer_id: str) -> FixtureLayer | None:
            return _BY_ID.get(layer_id) or added.get(layer_id)

        def add_result(project_id: str) -> None:
            if RESULT_LAYER not in results.setdefault(project_id, []):
                results[project_id].append(RESULT_LAYER)
            register(RESULT_LAYER)

        core = _Core(
            {
                **_core_routes(),
                **_workflow_core_routes(self.catalog, register, saved, results),
            }
        )
        processes = _Processes(
            {**_processes_routes(layer_of), **_run_routes(saved, add_result, layer_of)}
        )
        catalog = RecordingTransport(httpx.ASGITransport(app=self.catalog))
        services = fake_clients(
            core=core, geoapi=geoapi, processes=processes, catalog=catalog
        )
        requests = {
            "core": core.requests,
            "geoapi": geoapi.requests,
            "processes": processes.requests,
            "catalog": catalog.requests,
        }
        return services, requests, saved

    async def catalog_count(self, params: Mapping[str, Any]) -> int:
        transport = httpx.ASGITransport(app=self.catalog)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://catalog"
        ) as client:
            response = await client.get(
                "/stac/collections", params={**params, "limit": 1}
            )
            response.raise_for_status()
            return int(response.json()["numberMatched"])

    def project_value(self, oracle: Oracle) -> float | str:
        layer = _layer_named(oracle.layer)
        selected = [f for f in layer.features if matches(oracle.filter, f)]
        if oracle.op == "count":
            return float(len(selected))
        values = [
            f[oracle.field]
            for f in selected
            if oracle.field and f.get(oracle.field) is not None
        ]
        if oracle.op == "top":
            return str(Counter(values).most_common(1)[0][0])
        if oracle.op == "distinct":
            return float(len(set(values)))
        numbers = [float(v) for v in values]
        if oracle.op == "sum":
            return sum(numbers)
        if oracle.op == "min":
            return min(numbers)
        if oracle.op == "max":
            return max(numbers)
        return statistics.fmean(numbers)
