"""The style-check process: a GOAT Style document checked and computed against its layer."""

import contextlib
from typing import Any
from unittest.mock import MagicMock, patch

import duckdb
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from processes.main import app
from processes.routers.processes import (
    PUBLIC_ALLOWED_PROCESSES,
    SYNC_ANALYTICS_PROCESSES,
    _execute_analytics_sync,
)
from processes.services.access import analytics_references
from processes.services.analytics_registry import ANALYTICS_DEFINITIONS
from processes.services.analytics_service import AnalyticsService

LAYER = "3cdd1ea4-db25-414c-88ec-399ac841300c"
TABLE = "t_3cdd1ea4db25414c88ec399ac841300c"
QUANTILE_DOC = {
    "version": 1,
    "kind": "vector",
    "symbol": {"fill": {"color": "#cccccc"}},
    "classify": [
        {
            "id": "density",
            "field": "density",
            "method": "quantile",
            "count": 5,
            "palette": "colorbrewer:OrRd",
        }
    ],
}


def _fresh_connections() -> MagicMock:
    """A new in-memory connection per call, as production opens several."""
    manager = MagicMock()

    @contextlib.contextmanager
    def connection():
        con = duckdb.connect()
        try:
            yield con
        finally:
            con.close()

    manager.connection = connection
    return manager


@pytest.fixture
def catalog_layer(tmp_path, monkeypatch) -> AnalyticsService:
    """A promoted catalog layer of 100 districts, read through its parquet view."""
    monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
    con = duckdb.connect()
    con.execute(
        "COPY (SELECT (i * 100)::DOUBLE AS density, "
        "CASE WHEN i % 3 = 0 THEN 'school' ELSE 'park' END AS kind "
        f"FROM range(100) r(i)) TO '{tmp_path / f'{TABLE}.parquet'}' (FORMAT PARQUET)"
    )
    con.close()
    with patch(
        "processes.services.analytics_service.ducklake_manager", _fresh_connections()
    ):
        yield AnalyticsService()


def check(
    service: AnalyticsService, document: dict[str, Any], **kw: Any
) -> dict[str, Any]:
    return service.style_check(
        collection=LAYER,
        document=document,
        geometry=kw.get("geometry", "polygon"),
        compute=kw.get("compute", True),
        stored=kw.get("stored", False),
        fingerprint=kw.get("fingerprint", "ducklake:3"),
    )


def test_style_check_computes_and_validates(catalog_layer) -> None:
    result = check(catalog_layer, QUANTILE_DOC)
    c = result["document"]["classify"][0]
    assert len(c["classes"]) == 5 and c["computed"]["data"] == "ducklake:3"
    assert c["computed"]["at"].endswith("Z")
    assert result["issues"] == [] and result["feature_count"] == 100
    assert result["fields"] == [
        {"name": "density", "type": "number"},
        {"name": "kind", "type": "string"},
    ]


def test_without_compute_the_document_comes_back_as_it_was(catalog_layer) -> None:
    result = check(catalog_layer, QUANTILE_DOC, compute=False)
    assert result["document"] == QUANTILE_DOC


def test_unknown_fields_are_reported(catalog_layer) -> None:
    doc = {
        **QUANTILE_DOC,
        "classify": [{**QUANTILE_DOC["classify"][0], "field": "gone"}],
    }
    result = check(catalog_layer, doc, fingerprint=None)
    assert "unknown_field" in {i["code"] for i in result["issues"]}
    stored = check(catalog_layer, doc, stored=True)
    assert {i["level"] for i in stored["issues"] if i["code"] == "unknown_field"} == {
        "damaged"
    }


def test_top_categories_are_computed(catalog_layer) -> None:
    doc = {
        **QUANTILE_DOC,
        "classify": [
            {
                **QUANTILE_DOC["classify"][0],
                "field": "kind",
                "method": "categories",
                "count": 2,
            }
        ],
    }
    result = check(catalog_layer, doc)
    assert [k["values"] for k in result["document"]["classify"][0]["classes"]] == [
        ["park"],
        ["school"],
    ]


def test_a_raster_document_is_validated_only() -> None:
    service = AnalyticsService()
    with patch.object(service, "_get_table_name") as table:
        result = service.style_check(
            collection=LAYER,
            document={"version": 1, "kind": "raster", "render": {"type": "image"}},
            geometry=None,
            compute=True,
            stored=False,
            fingerprint=None,
        )
    table.assert_not_called()
    assert result["issues"] == [] and result["fields"] == []


def test_the_dispatch_validates_its_inputs() -> None:
    with pytest.raises(Exception) as err:
        _execute_analytics_sync("style-check", {"collection": LAYER, "document": "x"})
    assert getattr(err.value, "status_code", None) in (400, 422)


def test_style_check_needs_a_token() -> None:
    client = TestClient(app)
    response = client.post(
        "/processes/style-check/execution",
        json={"inputs": {"collection": LAYER, "document": QUANTILE_DOC}},
    )
    assert response.status_code == 401
    # The sync gate's answer, not the generic one every unknown process gets.
    assert response.json()["detail"]["title"] == "Authentication required"


def test_style_check_is_registered_hidden_and_reads_its_layer() -> None:
    assert ANALYTICS_DEFINITIONS["style-check"]["hidden"] is True
    assert "style-check" in SYNC_ANALYTICS_PROCESSES
    assert "style-check" not in PUBLIC_ALLOWED_PROCESSES
    refs = analytics_references("style-check", {"collection": LAYER, "document": {}})
    assert refs.entries == [{"kind": "layer", "id": LAYER, "action": "read"}]


def test_a_malformed_document_comes_back_as_issues(catalog_layer) -> None:
    doc = {**QUANTILE_DOC, "classify": [{**QUANTILE_DOC["classify"][0], "palette": 5}]}
    result = check(catalog_layer, doc)
    assert "invalid_value" in {i["code"] for i in result["issues"]}
    assert "classes" not in result["document"]["classify"][0]


def test_the_deployment_supports_rasters_and_h3(catalog_layer) -> None:
    h3 = check(
        catalog_layer,
        {"version": 1, "kind": "vector", "render": {"type": "h3"}},
        geometry="point",
    )
    assert "not_supported_yet" not in {i["code"] for i in h3["issues"]}
    service = AnalyticsService()
    result = service.style_check(
        collection=LAYER,
        document={
            "version": 1,
            "kind": "raster",
            "render": {"type": "continuous", "band": NDVI, "palette": "goat:elevation"},
        },
        geometry=None,
        compute=False,
        stored=False,
        fingerprint=None,
    )
    assert "not_supported_yet" not in {i["code"] for i in result["issues"]}


NDVI = {"name": "NDVI", "expression": "(b4 - b1) / (b4 + b1)"}


class FakeRaster:
    """A raster file as goatlib.raster reads it: one band of 100 to 400, or unreachable."""

    def __init__(
        self, url: str, private_hosts: object = (), *, fail: bool = False
    ) -> None:
        self.url, self.fail = url, fail

    def __enter__(self) -> "FakeRaster":
        if self.fail:
            from goatlib.raster.source import RasterUnavailableError

            raise RasterUnavailableError("timed out")
        return self

    def __exit__(self, *args: object) -> None:
        pass

    def info(self) -> Any:
        from goatlib.raster.source import RasterInfo

        return RasterInfo(
            512,
            512,
            (0, 0, 1, 1),
            1,
            "float32",
            -9999,
            (32,),
            None,
            (1.0,),
            (0.0,),
            ("Band 1",),
        )

    def statistics(self) -> list[Any]:
        from goatlib.raster.source import BandStats

        return [
            BandStats(
                1, 100.0, 400.0, 250.0, 80.0, 106.0, 394.0, ([1], [100.0, 400.0]), None
            )
        ]

    def sample(self, formula: Any) -> Any:
        import numpy as np

        return np.linspace(100, 400, 1001)


def raster_check(
    document: dict[str, Any],
    *,
    fail: bool = False,
    url: str | None = "https://cdn.example/dem.tif",
) -> dict[str, Any]:
    service = AnalyticsService()
    with patch(
        "processes.services.analytics_service.RasterSource",
        lambda u, hosts=(): FakeRaster(u, hosts, fail=fail),
    ):
        return service.style_check(
            collection=LAYER,
            document=document,
            geometry=None,
            compute=True,
            stored=False,
            fingerprint="url:abc",
            raster_url=url,
        )


def test_the_check_of_a_raster_file_computes_its_domain_and_classes() -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {
            "type": "continuous",
            "palette": "goat:elevation",
            "classify": {"method": "quantile", "count": 4},
        },
    }
    result = raster_check(doc)
    render = result["document"]["render"]
    assert (
        render["computed"]["domain"] == [100.0, 400.0]
        and render["computed"]["data"] == "url:abc"
    )
    assert len(render["classify"]["classes"]) == 4
    assert result["issues"] == []


def test_a_rasters_unknown_band_is_still_unknown_band() -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "continuous", "band": 3, "domain": [0, 1]},
    }
    assert "unknown_band" in {i["code"] for i in raster_check(doc)["issues"]}


def test_an_unreachable_raster_file_answers_503_so_core_keeps_the_style_stale() -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "continuous", "palette": "goat:elevation"},
    }
    with pytest.raises(HTTPException) as err:
        raster_check(doc, fail=True)
    assert err.value.status_code == 503


def test_a_raster_file_is_read_from_the_layer_row_never_from_the_request() -> None:
    with pytest.raises(Exception) as err:
        _execute_analytics_sync(
            "style-check",
            {
                "collection": LAYER,
                "document": {"version": 1, "kind": "raster"},
                "raster_url": "http://10.0.0.1/x.tif",
            },
        )
    assert getattr(err.value, "status_code", None) in (400, 422)


def test_the_route_hands_the_layer_rows_raster_address_to_the_check() -> None:
    seen: dict[str, Any] = {}

    def fake_check(**kw: Any) -> dict[str, Any]:
        seen.update(kw)
        return {
            "document": kw["document"],
            "issues": [],
            "feature_count": None,
            "fields": [],
        }

    with patch("processes.routers.processes.analytics_service.style_check", fake_check):
        _execute_analytics_sync(
            "style-check",
            {"collection": LAYER, "document": {"version": 1, "kind": "raster"}},
            None,
            raster_url="https://cdn.example/dem.tif",
        )
    assert seen["raster_url"] == "https://cdn.example/dem.tif"


async def test_the_raster_address_comes_from_a_raster_file_layer_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from processes.services import access

    class Pool:
        async def fetchval(self, sql: str, layer_id: str) -> str | None:
            assert "type = 'raster'" in sql and "data_type = 'cog'" in sql
            return "https://cdn.example/dem.tif" if layer_id == LAYER else None

    async def pool() -> Pool:
        return Pool()

    monkeypatch.setattr(access, "_get_pool", pool)
    assert await access.raster_file_url(LAYER) == "https://cdn.example/dem.tif"
    assert await access.raster_file_url("8b3b4b8e-0000-4000-8000-000000000000") is None
    assert await access.raster_file_url("not-a-uuid") is None
