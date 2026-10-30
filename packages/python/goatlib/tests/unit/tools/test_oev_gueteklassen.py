"""Unit tests for ÖV-Güteklassen tool parameter schema."""

from pathlib import Path

import pytest
from goatlib.analysis.schemas.catchment_area import Weekday
from goatlib.tools import oev_gueteklassen
from goatlib.tools.oev_gueteklassen import (
    CatchmentType,
    OevGueteklassenToolParams,
    OevGueteklassenToolRunner,
)


class TestOevGueteklassenToolParams:
    """Test OevGueteklassenToolParams validation and defaults."""

    BASE_PARAMS = {
        "user_id": "00000000-0000-0000-0000-000000000001",
        "reference_area_layer_id": "00000000-0000-0000-0000-000000000002",
    }

    def test_defaults(self):
        """Default weekday, time window and catchment type should be applied."""
        params = OevGueteklassenToolParams(**self.BASE_PARAMS)

        assert params.weekday == Weekday.weekday
        assert params.from_time == 25200
        assert params.to_time == 32400
        assert params.catchment_type == CatchmentType.buffer
        assert params.station_config is None

    def test_accepts_network_catchment_type(self):
        """Catchments can follow the street network instead of circles."""
        params = OevGueteklassenToolParams(
            **self.BASE_PARAMS,
            catchment_type="network",
        )
        assert params.catchment_type == CatchmentType.network

    def test_rejects_invalid_catchment_type(self):
        """Only buffer and network catchment types are supported."""
        with pytest.raises(ValueError):
            OevGueteklassenToolParams(
                **self.BASE_PARAMS,
                catchment_type="isochrone",
            )

    def test_accepts_custom_station_config(self):
        """Custom station config should be parsed and expanded for route mappings."""
        params = OevGueteklassenToolParams(
            **self.BASE_PARAMS,
            station_config={
                "groups": {"2": "A", "3": "C"},
                "time_frequency": [10, 20],
                "categories": [
                    {"A": 1, "C": 2},
                    {"A": 2, "C": 3},
                ],
                "classification": {
                    "1": {300: "1"},
                    "2": {300: "2"},
                    "3": {300: "3"},
                },
            },
        )

        assert params.station_config is not None
        assert params.station_config.groups["700"] == "C"
        assert params.station_config.groups["100"] == "A"


class TestStreetNetworkGraph:
    """Which street network the stations are walked on."""

    BASE_PARAMS = TestOevGueteklassenToolParams.BASE_PARAMS

    @pytest.fixture
    def fetched(self, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
        calls: list[tuple[str, str]] = []

        def picked(source, bundle_id, dest_dir):
            calls.append(("picked", bundle_id))
            return "edges", "nodes"

        def linked(source, bundle_id, dest_dir):
            calls.append(("linked", bundle_id))
            return "linked-edges", "linked-nodes"

        monkeypatch.setattr(oev_gueteklassen, "fetch_routing_network", picked)
        monkeypatch.setattr(oev_gueteklassen, "fetch_linked_routing_network", linked)
        return calls

    def _graph(self, **params) -> tuple[str, str] | None:
        return OevGueteklassenToolRunner()._street_network_graph(
            OevGueteklassenToolParams(**self.BASE_PARAMS, **params), Path("/tmp")
        )

    def test_circles_need_no_network(self, fetched) -> None:
        assert self._graph(street_network_bundle_id="street") is None
        assert fetched == []

    def test_default_network_without_bundles(self, fetched) -> None:
        assert self._graph(catchment_type="network") is None
        assert fetched == []

    def test_follows_the_pt_bundles_network(self, fetched) -> None:
        graph = self._graph(
            catchment_type="network", pt_network_bundle_id="pt", pt_date="2026-10-29"
        )
        assert graph == ("linked-edges", "linked-nodes")
        assert fetched == [("linked", "pt")]

    def test_the_picked_network_wins(self, fetched) -> None:
        graph = self._graph(
            catchment_type="network",
            street_network_bundle_id="street",
            pt_network_bundle_id="pt",
            pt_date="2026-10-29",
        )
        assert graph == ("edges", "nodes")
        assert fetched == [("picked", "street")]
