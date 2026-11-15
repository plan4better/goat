"""Tests for analytics service."""

import json
from unittest.mock import MagicMock, patch

import duckdb
import pytest

from processes.services.analytics_service import (
    AnalyticsService,
    analytics_service,
)


class TestAnalyticsServiceSingleton:
    """Tests for analytics service singleton."""

    def test_singleton_exists(self):
        """Test global analytics_service instance exists."""
        assert analytics_service is not None
        assert isinstance(analytics_service, AnalyticsService)


class TestAnalyticsServiceTableName:
    """Tests for _get_table_name method."""

    def test_get_table_name_format(self):
        """Test table name is properly formatted."""
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.normalize_layer_id"
        ) as mock_normalize:
            with patch(
                "processes.services.analytics_service.get_schema_for_layer"
            ) as mock_schema:
                with patch(
                    "processes.services.analytics_service._layer_id_to_table_name"
                ) as mock_table:
                    mock_normalize.return_value = "abc12345678901234567890123456789ab"
                    mock_schema.return_value = "user_xyz123"
                    mock_table.return_value = "t_abc12345678901234567890123456789ab"

                    result = service._get_table_name(
                        "abc12345-6789-0123-4567-890123456789"
                    )

                    assert (
                        result
                        == "lake.user_xyz123.t_abc12345678901234567890123456789ab"
                    )


class TestAnalyticsServiceBuildWhereClause:
    """Tests for _build_where_clause method."""

    def test_build_where_clause_none(self):
        """Test with no filter returns TRUE."""
        service = AnalyticsService()

        # Method requires table_name but doesn't use it for None filter
        where, params = service._build_where_clause(None, "lake.schema.table")

        assert where == "TRUE"
        assert params == []

    def test_build_where_clause_empty(self):
        """Test with empty filter returns TRUE."""
        service = AnalyticsService()

        where, params = service._build_where_clause("", "lake.schema.table")

        assert where == "TRUE"
        assert params == []

    def test_build_where_clause_invalid_json(self):
        """Test with invalid JSON filter returns TRUE."""
        service = AnalyticsService()

        # Invalid JSON should fall back to TRUE
        where, params = service._build_where_clause(
            "not valid json", "lake.schema.table"
        )

        assert where == "TRUE"
        assert params == []


class TestAnalyticsServiceFeatureCount:
    """Tests for feature_count method."""

    def test_feature_count_success(self):
        """Test successful feature count."""
        service = AnalyticsService()

        with patch.object(service, "_get_table_name") as mock_table:
            with patch.object(service, "_build_where_clause") as mock_where:
                with patch(
                    "processes.services.analytics_service.ducklake_manager"
                ) as mock_dm:
                    with patch(
                        "processes.services.analytics_service.calculate_feature_count"
                    ) as mock_calc:
                        mock_table.return_value = "lake.schema.table"
                        mock_where.return_value = ("TRUE", [])

                        mock_conn = MagicMock()
                        mock_dm.connection.return_value.__enter__ = MagicMock(
                            return_value=mock_conn
                        )
                        mock_dm.connection.return_value.__exit__ = MagicMock(
                            return_value=None
                        )

                        mock_result = MagicMock()
                        mock_result.model_dump.return_value = {"count": 42}
                        mock_calc.return_value = mock_result

                        result = service.feature_count("layer-123")

                        assert result["count"] == 42
                        mock_calc.assert_called_once()

    def test_feature_count_with_filter(self):
        """Test feature count with filter."""
        service = AnalyticsService()

        with patch.object(service, "_get_table_name") as mock_table:
            with patch.object(service, "_build_where_clause") as mock_where:
                with patch(
                    "processes.services.analytics_service.ducklake_manager"
                ) as mock_dm:
                    with patch(
                        "processes.services.analytics_service.calculate_feature_count"
                    ) as mock_calc:
                        mock_table.return_value = "lake.schema.table"
                        mock_where.return_value = ("category = ?", ["A"])

                        mock_conn = MagicMock()
                        mock_dm.connection.return_value.__enter__ = MagicMock(
                            return_value=mock_conn
                        )
                        mock_dm.connection.return_value.__exit__ = MagicMock(
                            return_value=None
                        )

                        mock_result = MagicMock()
                        mock_result.model_dump.return_value = {"count": 10}
                        mock_calc.return_value = mock_result

                        result = service.feature_count(
                            "layer-123", filter_expr="category='A'"
                        )

                        assert result["count"] == 10


class TestAnalyticsServiceUniqueValues:
    """Tests for unique_values method."""

    def test_unique_values_success(self):
        """Test successful unique values calculation."""
        service = AnalyticsService()

        with patch.object(service, "_get_table_name") as mock_table:
            with patch.object(service, "_build_where_clause") as mock_where:
                with patch(
                    "processes.services.analytics_service.ducklake_manager"
                ) as mock_dm:
                    with patch(
                        "processes.services.analytics_service.calculate_unique_values"
                    ) as mock_calc:
                        mock_table.return_value = "lake.schema.table"
                        mock_where.return_value = ("TRUE", [])

                        mock_conn = MagicMock()
                        mock_dm.connection.return_value.__enter__ = MagicMock(
                            return_value=mock_conn
                        )
                        mock_dm.connection.return_value.__exit__ = MagicMock(
                            return_value=None
                        )

                        mock_result = MagicMock()
                        mock_result.model_dump.return_value = {
                            "values": [
                                {"value": "A", "count": 10},
                                {"value": "B", "count": 5},
                            ]
                        }
                        mock_calc.return_value = mock_result

                        result = service.unique_values("layer-123", "category")

                        assert len(result["values"]) == 2
                        assert result["values"][0]["value"] == "A"


class TestAnalyticsServiceClassBreaks:
    """Tests for class_breaks method."""

    def test_class_breaks_success(self):
        """Test successful class breaks calculation."""
        service = AnalyticsService()

        with patch.object(service, "_get_table_name") as mock_table:
            with patch.object(service, "_build_where_clause") as mock_where:
                with patch(
                    "processes.services.analytics_service.ducklake_manager"
                ) as mock_dm:
                    with patch(
                        "processes.services.analytics_service.calculate_class_breaks"
                    ) as mock_calc:
                        mock_table.return_value = "lake.schema.table"
                        mock_where.return_value = ("TRUE", [])

                        mock_conn = MagicMock()
                        mock_dm.connection.return_value.__enter__ = MagicMock(
                            return_value=mock_conn
                        )
                        mock_dm.connection.return_value.__exit__ = MagicMock(
                            return_value=None
                        )

                        mock_result = MagicMock()
                        mock_result.model_dump.return_value = {
                            "breaks": [0, 25, 50, 75, 100],
                            "method": "quantile",
                        }
                        mock_calc.return_value = mock_result

                        # Use 'breaks' param (not 'num_classes')
                        result = service.class_breaks(
                            "layer-123", "population", breaks=5
                        )

                        assert len(result["breaks"]) == 5
                        assert result["method"] == "quantile"


class TestAnalyticsServiceAreaStatistics:
    """Tests for area_statistics method."""

    def test_area_statistics_success(self):
        """Test successful area statistics calculation."""
        service = AnalyticsService()

        with patch.object(service, "_get_table_name") as mock_table:
            with patch.object(service, "_build_where_clause") as mock_where:
                with patch(
                    "processes.services.analytics_service.ducklake_manager"
                ) as mock_dm:
                    with patch(
                        "processes.services.analytics_service.calculate_area_statistics"
                    ) as mock_calc:
                        mock_table.return_value = "lake.schema.table"
                        mock_where.return_value = ("TRUE", [])

                        mock_conn = MagicMock()
                        mock_dm.connection.return_value.__enter__ = MagicMock(
                            return_value=mock_conn
                        )
                        mock_dm.connection.return_value.__exit__ = MagicMock(
                            return_value=None
                        )

                        mock_result = MagicMock()
                        mock_result.model_dump.return_value = {
                            "total_area": 1000.5,
                            "unit": "square_meters",
                        }
                        mock_calc.return_value = mock_result

                        result = service.area_statistics("layer-123", operation="sum")

                        assert result["total_area"] == 1000.5
                        assert result["unit"] == "square_meters"

    def test_area_statistics_passes_the_group_column(self):
        service = AnalyticsService()
        with (
            patch.object(service, "_get_table_name") as mock_table,
            patch.object(service, "_build_where_clause") as mock_where,
            patch("processes.services.analytics_service.ducklake_manager") as mock_dm,
            patch(
                "processes.services.analytics_service.calculate_area_statistics"
            ) as mock_calc,
        ):
            mock_table.return_value = "lake.schema.table"
            mock_where.return_value = ("TRUE", [])
            mock_dm.connection.return_value.__enter__ = MagicMock(
                return_value=MagicMock()
            )
            mock_dm.connection.return_value.__exit__ = MagicMock(return_value=None)
            mock_calc.return_value = MagicMock(model_dump=lambda: {"groups": []})

            service.area_statistics(
                "layer-123", operation="sum", group_by_column="zone"
            )

            assert mock_calc.call_args.kwargs["group_by_column"] == "zone"


class TestCatalogLayers:
    """A promoted catalog layer is not in DuckLake.

    It is one parquet file in the shared catalog layers directory, read through
    a `catalog_layers."t_…"` view — the same relation geoapi serves it from.
    Resolving it through the lake asks the catalog for a table that was never
    registered there, which came back as `404 Layer not found` and left the data
    table's filter popover, feature counts and class breaks empty for every
    catalog layer.
    """

    LAYER_ID = "3cdd1ea4-db25-414c-88ec-399ac841300c"
    TABLE = "t_3cdd1ea4db25414c88ec399ac841300c"

    @staticmethod
    def _write_layer(directory, table, rows=None):
        import duckdb as _duckdb

        directory.mkdir(parents=True, exist_ok=True)
        values = rows or [("road", 10), ("road", 20), ("rail", 30)]
        literal = ", ".join(f"('{k}', {v})" for k, v in values)
        con = _duckdb.connect()
        con.execute(
            f"COPY (SELECT * FROM (VALUES {literal}) AS t(source, level)) "
            f"TO '{directory / f'{table}.parquet'}' (FORMAT PARQUET)"
        )
        con.close()

    @staticmethod
    def _fresh_connections():
        """A manager handing out a NEW in-memory connection per call.

        Production opens several per request, so the view has to be created on
        each one — a fixture that reuses a single connection would hide that.
        """
        import contextlib

        import duckdb as _duckdb

        manager = MagicMock()

        @contextlib.contextmanager
        def connection():
            con = _duckdb.connect()
            try:
                yield con
            finally:
                con.close()

        manager.connection = connection
        return manager

    def test_the_relation_is_the_catalog_view_when_the_parquet_exists(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
        self._write_layer(tmp_path, self.TABLE)
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.get_schema_for_layer"
        ) as mock_schema:
            result = service._get_table_name(self.LAYER_ID)

        assert result == f'catalog_layers."{self.TABLE}"'
        mock_schema.assert_not_called(), "the lake must not be consulted at all"

    def test_a_ducklake_layer_still_resolves_through_the_lake(
        self, tmp_path, monkeypatch
    ):
        """No parquet on disk means it is an ordinary layer — unchanged path."""
        monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.get_schema_for_layer",
            return_value="main",
        ):
            result = service._get_table_name(self.LAYER_ID)

        assert result == f"lake.main.{self.TABLE}"

    def test_unique_values_reads_a_catalog_layer(self, tmp_path, monkeypatch):
        """What the data table's filter popover asks for."""
        monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
        self._write_layer(tmp_path, self.TABLE)
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.ducklake_manager",
            self._fresh_connections(),
        ):
            result = service.unique_values(self.LAYER_ID, "source")

        values = {v["value"]: v["count"] for v in result["values"]}
        assert values == {"road": 2, "rail": 1}

    def test_feature_count_reads_a_catalog_layer(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
        self._write_layer(tmp_path, self.TABLE)
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.ducklake_manager",
            self._fresh_connections(),
        ):
            result = service.feature_count(self.LAYER_ID)

        assert result["count"] == 3

    def test_class_breaks_read_a_catalog_layer(self, tmp_path, monkeypatch):
        """Styling asks for these; an empty answer is why a catalog layer could
        not be classified."""
        monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
        self._write_layer(tmp_path, self.TABLE)
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.ducklake_manager",
            self._fresh_connections(),
        ):
            result = service.class_breaks(self.LAYER_ID, "level", "quantile", 2)

        assert result["breaks"]

    def test_column_names_read_a_catalog_layer(self, tmp_path, monkeypatch):
        """What the workflow check compares field settings with."""
        monkeypatch.setenv("CATALOG_LAYERS_DIR", str(tmp_path))
        self._write_layer(tmp_path, self.TABLE)
        service = AnalyticsService()

        with patch(
            "processes.services.analytics_service.ducklake_manager",
            self._fresh_connections(),
        ):
            names = service.column_names(self.LAYER_ID)

        # rowid is the view's own column (`catalog_view_sql`).
        assert names == ["rowid", "source", "level"]


def test_validate_sql_loads_spatial_through_goatlib(monkeypatch) -> None:
    """Extensions come from the image's baked directory; goatlib's
    load_extensions never downloads there."""
    from goatlib.storage import load_extensions as real_load

    import processes.services.analytics_service as module

    loaded: list[tuple[str, ...]] = []

    def record(con, *ext):
        loaded.append(ext)
        real_load(con, *ext)

    monkeypatch.setattr(module, "load_extensions", record)

    result = AnalyticsService().validate_sql(
        "SELECT name FROM t", {"t": {"name": "VARCHAR"}}
    )

    assert result["valid"], result
    assert loaded == [("spatial",)]


class TestLayerJustSaved:
    """Analytics read a pinned DuckLake snapshot that the poll moves forward
    off the request path, which takes several seconds. A layer a workflow run
    has just saved is in the catalog (its schema resolves from Postgres) but
    not yet in the pin, and its table "does not exist" for that long: the
    statistics asked right after the run answered 500.
    """

    LAYER_ID = "5f0c2a8e-1b7d-4c3e-9a6f-2d8e4b1c7a90"
    TABLE = "t_5f0c2a8e1b7d4c3e9a6f2d8e4b1c7a90"

    class _Pinned:
        """A manager whose connections see the table only once the pin has
        moved: `force_pin_refresh` moves it, or the poll after `swap_after`
        connections (a swap landing in the middle of a request)."""

        def __init__(
            self,
            table: str,
            *,
            refreshes: bool = True,
            swap_after: int | None = None,
            error: str | None = None,
        ) -> None:
            import duckdb as _duckdb

            self.db = _duckdb.connect()
            self.db.execute("ATTACH ':memory:' AS lake")
            self.table = table
            self.visible = False
            self.refreshes = refreshes
            self.swap_after = swap_after
            self.error = error
            self.connections = 0
            self.refresh_calls = 0

        def _show(self) -> None:
            if not self.visible:
                self.db.execute(
                    f"CREATE TABLE lake.main.{self.table} AS SELECT * FROM "
                    "(VALUES ('road', 10), ('road', 20), ('rail', 30)) "
                    "AS t(source, level)"
                )
                self.visible = True

        def connection(self):
            import contextlib

            @contextlib.contextmanager
            def connect():
                if self.swap_after is not None and self.connections >= self.swap_after:
                    self._show()
                self.connections += 1
                if self.error is not None:
                    raise RuntimeError(self.error)
                yield self.db.cursor()

            return connect()

        def force_pin_refresh(self) -> bool:
            self.refresh_calls += 1
            if self.refreshes:
                self._show()
            return self.refreshes

    def _service(self, monkeypatch, manager) -> AnalyticsService:
        monkeypatch.setattr(
            "processes.services.analytics_service.get_schema_for_layer",
            lambda layer_id: "main",
        )
        monkeypatch.setattr(
            "processes.services.analytics_service.ducklake_manager", manager
        )
        return AnalyticsService()

    def test_a_layer_the_pin_does_not_hold_yet_is_read_after_a_refresh(
        self, monkeypatch
    ):
        manager = self._Pinned(self.TABLE)
        service = self._service(monkeypatch, manager)

        assert service.feature_count(self.LAYER_ID)["count"] == 3
        assert service.class_breaks(self.LAYER_ID, "level", "quantile", 2)["max"] == 30
        assert manager.refresh_calls == 1

    def test_every_layer_statistic_refreshes_a_pin_that_misses(self, monkeypatch):
        reads = {
            "unique_values": lambda s: s.unique_values(self.LAYER_ID, "source"),
            "aggregation_stats": lambda s: s.aggregation_stats(self.LAYER_ID),
            "histogram": lambda s: s.histogram(self.LAYER_ID, "level"),
        }
        for name, read in reads.items():
            manager = self._Pinned(self.TABLE)
            read(self._service(monkeypatch, manager))
            assert manager.refresh_calls == 1, name

    def test_a_filter_is_not_dropped_when_the_pin_moves_mid_request(self, monkeypatch):
        """The filter's columns are read on a connection of their own: one
        that missed must not leave the statistic unfiltered once the next
        connection sees the table."""
        manager = self._Pinned(self.TABLE, swap_after=1)
        service = self._service(monkeypatch, manager)
        road = json.dumps({"op": "=", "args": [{"property": "source"}, "road"]})

        result = service.aggregation_stats(self.LAYER_ID, filter_expr=road)

        assert result["total_count"] == 2

    def test_a_table_missing_after_the_refresh_is_still_an_error(self, monkeypatch):
        manager = self._Pinned(self.TABLE)
        manager.force_pin_refresh = lambda: True  # the pin is current: no table
        service = self._service(monkeypatch, manager)

        with pytest.raises(duckdb.CatalogException, match="does not exist"):
            service.feature_count(self.LAYER_ID)

    def test_a_failed_refresh_is_not_retried(self, monkeypatch):
        manager = self._Pinned(self.TABLE, refreshes=False)
        service = self._service(monkeypatch, manager)

        with pytest.raises(duckdb.CatalogException, match="does not exist"):
            service.feature_count(self.LAYER_ID)
        assert manager.refresh_calls == 1

    def test_other_errors_do_not_refresh_the_pin(self, monkeypatch):
        manager = self._Pinned(
            self.TABLE,
            error='Binder Error: Referenced column "x" not found in FROM clause!',
        )
        service = self._service(monkeypatch, manager)

        with pytest.raises(RuntimeError, match="Binder Error"):
            service.feature_count(self.LAYER_ID)
        assert manager.refresh_calls == 0
