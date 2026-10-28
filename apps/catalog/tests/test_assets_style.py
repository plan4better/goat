"""The style asset is served as a GOAT Style document (spec 17): an object a
harvester wrote before GOAT Style (no `version`) is upgraded on read for the
item's geometry, one that does not validate is replaced by the default, behind the
same conditional GET as any asset."""

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from catalog.app import create_app
from catalog.config import CatalogSettings
from tests.test_assets import BUCKET, _LocalReader

ITEM = "baumkataster-rheinland-pfalz-198"
V0 = {"color": [0, 170, 0], "stroke_color": [0, 170, 0], "stroke_width": 3}
V1 = {"version": 1, "kind": "vector", "symbol": {"line": {"color": "#aa0000"}}}


def _get(catalog_dir: Path, tmp_path: Path, document: Any, **headers: str) -> Any:
    root = tmp_path / "bucket"
    (root / "styles").mkdir(parents=True)
    (root / "styles" / "s.json").write_text(json.dumps(document))
    settings = CatalogSettings(
        data_dir=catalog_dir,
        auth=False,
        s3_catalog_bucket=BUCKET,
        s3_access_key_id="key",
        s3_secret_access_key="secret",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        reader = _LocalReader(settings, root)
        original = reader.read

        def read(kind: Any, row: dict[str, Any]) -> Any:
            assets = {"style": {"href": "../../../styles/s.json"}}
            return original(kind, {**row, "assets": assets})

        reader.read = read  # type: ignore[method-assign]
        app.state.asset_reader = reader
        geometry = app.state.store.query(
            f'SELECT "goat:geometryType" FROM {app.state.store.ITEMS} WHERE id = ?',
            [ITEM],
        )[0][0]
        etag = f'W/"{app.state.store.etag_seed}"'
        response = client.get(f"/assets/{ITEM}/style", headers=headers)
        conditional = client.get(
            f"/assets/{ITEM}/style", headers={"If-None-Match": etag}
        )
    return response, conditional, geometry


def test_a_version_0_style_object_is_served_as_version_1(
    catalog_dir: Path, tmp_path: Path
) -> None:
    response, conditional, geometry = _get(catalog_dir, tmp_path, V0)
    assert response.status_code == 200
    doc = response.json()
    assert (doc["version"], doc["kind"]) == (1, "vector")
    part = {"point": "marker", "line": "line", "polygon": "fill"}[geometry]
    assert doc["symbol"][part]["color"] == "#00aa00"
    assert response.headers["content-type"].startswith("application/json")
    assert conditional.status_code == 304


def test_a_version_1_style_object_is_served_as_published(
    catalog_dir: Path, tmp_path: Path
) -> None:
    response, _, _ = _get(catalog_dir, tmp_path, V1)
    assert response.json() == V1


def test_a_style_object_that_does_not_validate_is_served_as_the_default(
    catalog_dir: Path, tmp_path: Path
) -> None:
    broken = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "nope"}}}
    response, _, geometry = _get(catalog_dir, tmp_path, broken)
    doc = response.json()
    part = {"point": "marker", "line": "line", "polygon": "fill"}[geometry]
    assert doc["version"] == 1 and doc["symbol"][part]["color"] != "nope"
