"""Tests for CatchmentAreaV2 schemas and environmental walkability parameters."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from goatlib.analysis.schemas.catchment_area import StartingPointsMap
from goatlib.analysis.schemas.catchment_area_v2 import (
    CatchmentAreaV2Params,
)
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2WindmillParams,
)
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Test: CatchmentAreaV2Params Environmental Walkability
# ---------------------------------------------------------------------------


class TestCatchmentAreaV2ParamsEnvironmentalWalkability:
    """Tests for environmental walkability weights in CatchmentAreaV2Params."""

    def test_default_weights_are_zero(self) -> None:
        """Baseline default weights must be 0.0 to prevent regression."""
        params = CatchmentAreaV2Params(
            latitude=48.137,
            longitude=11.576,
            output_path="/tmp/catchment.parquet",
        )
        assert params.shade_weight == 0.0
        assert params.heat_weight == 0.0
        assert params.slope_walk_weight == 0.0

    def test_custom_valid_weights(self) -> None:
        """Custom valid weights within specified bounds are accepted."""
        params = CatchmentAreaV2Params(
            latitude=48.137,
            longitude=11.576,
            output_path="/tmp/catchment.parquet",
            shade_weight=1.5,
            heat_weight=2.0,
            slope_walk_weight=0.8,
        )
        assert params.shade_weight == 1.5
        assert params.heat_weight == 2.0
        assert params.slope_walk_weight == 0.8

    @pytest.mark.parametrize(
        "field,invalid_val",
        [
            ("shade_weight", -0.1),
            ("shade_weight", 5.1),
            ("heat_weight", -0.5),
            ("heat_weight", 5.5),
            ("slope_walk_weight", -0.1),
            ("slope_walk_weight", 3.1),
        ],
    )
    def test_weight_boundary_validation(self, field: str, invalid_val: float) -> None:
        """Weights exceeding bounds or negative must fail validation."""
        kwargs = {
            "latitude": 48.137,
            "longitude": 11.576,
            "output_path": "/tmp/catchment.parquet",
            field: invalid_val,
        }
        with pytest.raises(ValidationError):
            CatchmentAreaV2Params(**kwargs)


# ---------------------------------------------------------------------------
# Test: CatchmentAreaV2WindmillParams Environmental Walkability
# ---------------------------------------------------------------------------


class TestCatchmentAreaV2WindmillParamsEnvironmentalWalkability:
    """Tests for Windmill tool params schema and UI field integration."""

    def test_windmill_params_defaults(self) -> None:
        """Windmill tool schema defaults to 0.0 for all environmental weights."""
        params = CatchmentAreaV2WindmillParams(
            user_id="test-user",
            routing_mode="walking",
            starting_points=StartingPointsMap(
                latitude=[48.137],
                longitude=[11.576],
            ),
        )
        assert params.shade_weight == 0.0
        assert params.heat_weight == 0.0
        assert params.slope_walk_weight == 0.0

    def test_windmill_params_custom_values(self) -> None:
        """Windmill tool schema accepts custom environmental weights."""
        params = CatchmentAreaV2WindmillParams(
            user_id="test-user",
            routing_mode="walking",
            starting_points=StartingPointsMap(
                latitude=[48.137],
                longitude=[11.576],
            ),
            shade_weight=2.5,
            heat_weight=1.2,
            slope_walk_weight=1.0,
        )
        assert params.shade_weight == 2.5
        assert params.heat_weight == 1.2
        assert params.slope_walk_weight == 1.0


# ---------------------------------------------------------------------------
# Test: Mode and Cost Type Validation for Environmental Walkability
# ---------------------------------------------------------------------------


class TestEnvironmentalWalkabilityModeAndCostTypeValidation:
    """Verifies that non-zero environmental walkability weights are only permitted
    when routing_mode is walking and cost_type is time.
    """

    @pytest.mark.parametrize(
        "invalid_mode",
        ["bicycle", "pedelec", "car", "pt"],
    )
    def test_catchment_v2_rejects_non_walking_mode_with_weights(
        self, invalid_mode: str
    ) -> None:
        with pytest.raises(ValidationError, match="walking"):
            CatchmentAreaV2Params(
                latitude=48.137,
                longitude=11.576,
                output_path="/tmp/catchment.parquet",
                routing_mode=invalid_mode,
                shade_weight=1.0,
            )

    def test_catchment_v2_rejects_distance_cost_type_with_weights(self) -> None:
        with pytest.raises(ValidationError, match="time"):
            CatchmentAreaV2Params(
                latitude=48.137,
                longitude=11.576,
                output_path="/tmp/catchment.parquet",
                routing_mode="walking",
                cost_type="distance",
                heat_weight=1.0,
            )

    def test_catchment_v2_permits_non_walking_and_distance_when_weights_zero(
        self,
    ) -> None:
        params_car = CatchmentAreaV2Params(
            latitude=48.137,
            longitude=11.576,
            output_path="/tmp/catchment.parquet",
            routing_mode="car",
            shade_weight=0.0,
            heat_weight=0.0,
            slope_walk_weight=0.0,
        )
        assert params_car.routing_mode == "car"

        params_dist = CatchmentAreaV2Params(
            latitude=48.137,
            longitude=11.576,
            output_path="/tmp/catchment.parquet",
            routing_mode="walking",
            cost_type="distance",
            shade_weight=0.0,
        )
        assert params_dist.cost_type == "distance"

    def test_heatmap_v2_rejects_non_walking_or_distance_with_weights(self) -> None:
        from goatlib.analysis.schemas.heatmap_v2 import (
            HeatmapType,
            HeatmapV2Params,
            OpportunityV2,
        )

        opp = OpportunityV2(
            layer_id="parks",
            input_path="/tmp/parks.parquet",
            weight=1.0,
            max_cost=15,
        )
        with pytest.raises(ValidationError, match="walking"):
            HeatmapV2Params(
                heatmap_type=HeatmapType.gravity,
                opportunities=[opp],
                output_path="/tmp/heatmap.parquet",
                routing_mode="bicycle",
                slope_walk_weight=0.5,
            )
        with pytest.raises(ValidationError, match="time"):
            HeatmapV2Params(
                heatmap_type=HeatmapType.gravity,
                opportunities=[opp],
                output_path="/tmp/heatmap.parquet",
                routing_mode="walking",
                cost_type="distance",
                shade_weight=1.0,
            )

    def test_travel_cost_matrix_rejects_non_walking_or_distance_with_weights(
        self,
    ) -> None:
        from goatlib.analysis.schemas.travel_cost_matrix import (
            TravelCostMatrixParams,
        )

        with pytest.raises(ValidationError, match="walking"):
            TravelCostMatrixParams(
                origin_latitude=[48.137],
                origin_longitude=[11.576],
                destination_latitude=[48.140],
                destination_longitude=[11.580],
                output_path="/tmp/matrix.parquet",
                routing_mode="car",
                heat_weight=1.0,
            )
        with pytest.raises(ValidationError, match="time"):
            TravelCostMatrixParams(
                origin_latitude=[48.137],
                origin_longitude=[11.576],
                destination_latitude=[48.140],
                destination_longitude=[11.580],
                output_path="/tmp/matrix.parquet",
                routing_mode="walking",
                cost_type="distance",
                slope_walk_weight=1.0,
            )

    def test_windmill_ui_visible_when_condition(self) -> None:
        from goatlib.tools.catchment_area_v2 import CatchmentAreaV2WindmillParams
        from goatlib.tools.heatmap_v2 import HeatmapV2WindmillParams
        from goatlib.tools.travel_cost_matrix import (
            TravelCostMatrixWindmillParams,
        )

        for model_cls in (
            CatchmentAreaV2WindmillParams,
            HeatmapV2WindmillParams,
            TravelCostMatrixWindmillParams,
        ):
            schema = model_cls.model_json_schema()
            props = schema["properties"]
            for field_name in ("shade_weight", "heat_weight", "slope_walk_weight"):
                field_ui = props[field_name].get("x-ui", {})
                assert field_ui.get("visible_when") == {"routing_mode": "walking"}, (
                    f"{model_cls.__name__}.{field_name} missing visible_when for walking"
                )


# ---------------------------------------------------------------------------
# Test: HeatmapV2 and TravelCostMatrix Environmental Walkability
# ---------------------------------------------------------------------------


class TestHeatmapV2AndMatrixEnvironmentalWalkability:
    """Verifies that HeatmapV2Params and TravelCostMatrixParams expose weights."""

    def test_heatmap_v2_params_defaults_and_custom(self) -> None:
        from goatlib.analysis.schemas.heatmap_v2 import (
            HeatmapType,
            HeatmapV2Params,
            OpportunityV2,
        )

        # Defaults
        hparams = HeatmapV2Params(
            heatmap_type=HeatmapType.gravity,
            opportunities=[
                OpportunityV2(
                    layer_id="parks",
                    input_path="/tmp/parks.parquet",
                    weight=1.0,
                    max_cost=15,
                )
            ],
            output_path="/tmp/heatmap.parquet",
        )
        assert hparams.shade_weight == 0.0
        assert hparams.heat_weight == 0.0
        assert hparams.slope_walk_weight == 0.0

        # Custom
        hparams_custom = HeatmapV2Params(
            heatmap_type=HeatmapType.gravity,
            opportunities=[
                OpportunityV2(
                    layer_id="parks",
                    input_path="/tmp/parks.parquet",
                    weight=1.0,
                    max_cost=15,
                )
            ],
            output_path="/tmp/heatmap.parquet",
            shade_weight=1.2,
            heat_weight=2.0,
            slope_walk_weight=0.5,
        )
        assert hparams_custom.shade_weight == 1.2
        assert hparams_custom.heat_weight == 2.0
        assert hparams_custom.slope_walk_weight == 0.5

    def test_travel_cost_matrix_params_defaults_and_custom(self) -> None:
        from goatlib.analysis.schemas.travel_cost_matrix import (
            TravelCostMatrixParams,
        )

        # Defaults
        mparams = TravelCostMatrixParams(
            origin_latitude=[48.137],
            origin_longitude=[11.576],
            destination_latitude=[48.140],
            destination_longitude=[11.580],
            output_path="/tmp/matrix.parquet",
        )
        assert mparams.shade_weight == 0.0
        assert mparams.heat_weight == 0.0
        assert mparams.slope_walk_weight == 0.0

        # Custom
        mparams_custom = TravelCostMatrixParams(
            origin_latitude=[48.137],
            origin_longitude=[11.576],
            destination_latitude=[48.140],
            destination_longitude=[11.580],
            output_path="/tmp/matrix.parquet",
            shade_weight=1.5,
            heat_weight=1.8,
            slope_walk_weight=0.4,
        )
        assert mparams_custom.shade_weight == 1.5
        assert mparams_custom.heat_weight == 1.8
        assert mparams_custom.slope_walk_weight == 0.4

    def test_heatmap_v2_windmill_params_defaults_and_custom(self) -> None:
        from goatlib.tools.heatmap_v2 import (
            HeatmapRoutingMode,
            HeatmapV2WindmillParams,
        )

        # Defaults
        hparams = HeatmapV2WindmillParams(
            user_id="test-user",
            routing_mode=HeatmapRoutingMode.walking,
        )
        assert hparams.shade_weight == 0.0
        assert hparams.heat_weight == 0.0
        assert hparams.slope_walk_weight == 0.0

        # Custom values
        hparams_custom = HeatmapV2WindmillParams(
            user_id="test-user",
            routing_mode=HeatmapRoutingMode.walking,
            shade_weight=1.5,
            heat_weight=2.2,
            slope_walk_weight=0.7,
        )
        assert hparams_custom.shade_weight == 1.5
        assert hparams_custom.heat_weight == 2.2
        assert hparams_custom.slope_walk_weight == 0.7

    def test_travel_cost_matrix_windmill_params_defaults_and_custom(self) -> None:
        from goatlib.tools.travel_cost_matrix import (
            TravelCostMatrixWindmillParams,
        )

        # Defaults
        mparams = TravelCostMatrixWindmillParams(
            user_id="test-user",
            origin_layer_id="origin-layer",
            destination_layer_id="destination-layer",
            origin_id_column="id",
            destination_id_column="id",
            routing_mode="walking",
        )
        assert mparams.shade_weight == 0.0
        assert mparams.heat_weight == 0.0
        assert mparams.slope_walk_weight == 0.0

        # Custom values
        mparams_custom = TravelCostMatrixWindmillParams(
            user_id="test-user",
            origin_layer_id="origin-layer",
            destination_layer_id="destination-layer",
            origin_id_column="id",
            destination_id_column="id",
            routing_mode="walking",
            shade_weight=2.0,
            heat_weight=1.5,
            slope_walk_weight=0.9,
        )
        assert mparams_custom.shade_weight == 2.0
        assert mparams_custom.heat_weight == 1.5
        assert mparams_custom.slope_walk_weight == 0.9

    @pytest.mark.parametrize(
        "field,invalid_val",
        [
            ("shade_weight", -0.1),
            ("shade_weight", 5.1),
            ("heat_weight", -0.5),
            ("heat_weight", 5.5),
            ("slope_walk_weight", -0.1),
            ("slope_walk_weight", 3.1),
        ],
    )
    def test_heatmap_v2_params_boundary_validation(
        self, field: str, invalid_val: float
    ) -> None:
        from goatlib.analysis.schemas.heatmap_v2 import (
            HeatmapType,
            HeatmapV2Params,
            OpportunityV2,
        )

        kwargs = {
            "heatmap_type": HeatmapType.gravity,
            "opportunities": [
                OpportunityV2(
                    layer_id="parks",
                    input_path="/tmp/parks.parquet",
                    weight=1.0,
                    max_cost=15,
                )
            ],
            "output_path": "/tmp/heatmap.parquet",
            field: invalid_val,
        }
        with pytest.raises(ValidationError):
            HeatmapV2Params(**kwargs)

    @pytest.mark.parametrize(
        "field,invalid_val",
        [
            ("shade_weight", -0.1),
            ("shade_weight", 5.1),
            ("heat_weight", -0.5),
            ("heat_weight", 5.5),
            ("slope_walk_weight", -0.1),
            ("slope_walk_weight", 3.1),
        ],
    )
    def test_travel_cost_matrix_params_boundary_validation(
        self, field: str, invalid_val: float
    ) -> None:
        from goatlib.analysis.schemas.travel_cost_matrix import (
            TravelCostMatrixParams,
        )

        kwargs = {
            "origin_latitude": [48.137],
            "origin_longitude": [11.576],
            "destination_latitude": [48.140],
            "destination_longitude": [11.580],
            "output_path": "/tmp/matrix.parquet",
            field: invalid_val,
        }
        with pytest.raises(ValidationError):
            TravelCostMatrixParams(**kwargs)


# ---------------------------------------------------------------------------
# Test: Config Builder Propagation to C++ Routing Configurations
# ---------------------------------------------------------------------------


class TestAnalysisToolConfigBuilderPropagation:
    """Verifies that AnalysisTool implementations propagate environmental walkability
    weights from Pydantic analysis params to C++ engine configuration objects.
    """

    def test_catchment_v2_build_request_config_propagates_weights(self) -> None:
        from goatlib.analysis.accessibility.catchment_area_v2 import (
            CatchmentAreaToolV2,
        )

        class DummyRequestConfig:
            pass

        class DummyPoint3857:
            def __init__(self, x: Any, y: Any) -> None:
                pass

        class DummyRouting:
            RequestConfig = DummyRequestConfig
            Point3857 = DummyPoint3857

            class RoutingMode:
                Walking = "Walking"
                Bicycle = "Bicycle"
                Pedelec = "Pedelec"
                Car = "Car"
                PublicTransport = "PublicTransport"

            class CostType:
                Time = "Time"
                Distance = "Distance"

            class CatchmentType:
                Polygon = "Polygon"
                Network = "Network"
                HexagonalGrid = "HexagonalGrid"
                PointGrid = "PointGrid"

            class OutputFormat:
                Parquet = "Parquet"
                GeoJSON = "GeoJSON"

            class ShapeStyle:
                Combined = "Combined"
                Separated = "Separated"

        params = CatchmentAreaV2Params(
            latitude=48.137,
            longitude=11.576,
            output_path="/tmp/catchment.parquet",
            shade_weight=1.5,
            heat_weight=2.0,
            slope_walk_weight=0.8,
        )

        tool = CatchmentAreaToolV2()
        with mock.patch.object(tool, "_get_routing_module", return_value=DummyRouting):
            cfg = tool._build_request_config(params)
            assert cfg.shade_weight == 1.5
            assert cfg.heat_weight == 2.0
            assert cfg.slope_walk_weight == 0.8

    def test_heatmap_v2_build_heatmap_config_propagates_weights(self) -> None:
        from goatlib.analysis.accessibility.heatmap_v2 import HeatmapV2Tool
        from goatlib.analysis.schemas.heatmap_v2 import (
            HeatmapType,
            HeatmapV2Params,
            OpportunityV2,
        )

        class DummyHeatmapConfig:
            pass

        class DummyOpportunity:
            def __init__(self, seeds: Any, w: Any, rep: Any) -> None:
                pass

        class DummyPoint3857:
            def __init__(self, x: Any, y: Any) -> None:
                pass

        class DummyRouting:
            HeatmapConfig = DummyHeatmapConfig
            Opportunity = DummyOpportunity
            Point3857 = DummyPoint3857

            class RoutingMode:
                Walking = "Walking"
                Bicycle = "Bicycle"
                Pedelec = "Pedelec"
                Car = "Car"
                PublicTransport = "PublicTransport"

            class CostType:
                Time = "Time"
                Distance = "Distance"

            class HeatmapType:
                Gravity = "Gravity"
                ClosestAverage = "ClosestAverage"
                Connectivity = "Connectivity"
                TwoSFCA = "TwoSFCA"

            class GravityDecay:
                Gaussian = "Gaussian"
                Exponential = "Exponential"
                Linear = "Linear"
                Power = "Power"
                Cumulative = "Cumulative"

        params = HeatmapV2Params(
            heatmap_type=HeatmapType.gravity,
            opportunities=[
                OpportunityV2(
                    layer_id="parks",
                    input_path="/tmp/parks.parquet",
                    weight=1.0,
                    max_cost=15,
                )
            ],
            output_path="/tmp/heatmap.parquet",
            shade_weight=1.2,
            heat_weight=2.5,
            slope_walk_weight=0.6,
        )

        tool = HeatmapV2Tool()
        with mock.patch.object(tool, "_get_routing_module", return_value=DummyRouting):
            opp_groups = [([(1288578.0, 6130064.0)], 1.0, 1288578.0, 6130064.0)]
            cfg = tool._build_heatmap_cfg(
                params=params,
                opp_groups=opp_groups,
                sensitivity=0.5,
                output_path="/tmp/heatmap.parquet",
            )
            assert cfg.shade_weight == 1.2
            assert cfg.heat_weight == 2.5
            assert cfg.slope_walk_weight == 0.6

    def test_travel_cost_matrix_build_matrix_config_propagates_weights(self) -> None:
        from goatlib.analysis.accessibility.travel_cost_matrix import (
            TravelCostMatrixTool,
        )
        from goatlib.analysis.schemas.travel_cost_matrix import (
            TravelCostMatrixParams,
        )

        class DummyMatrixConfig:
            pass

        class DummyPoint3857:
            def __init__(self, x: Any, y: Any) -> None:
                pass

        class DummyRouting:
            MatrixConfig = DummyMatrixConfig
            Point3857 = DummyPoint3857

            class RoutingMode:
                Walking = "Walking"
                Bicycle = "Bicycle"
                Pedelec = "Pedelec"
                Car = "Car"
                PublicTransport = "PublicTransport"

            class CostType:
                Time = "Time"
                Distance = "Distance"

        params = TravelCostMatrixParams(
            origin_latitude=[48.137],
            origin_longitude=[11.576],
            destination_latitude=[48.140],
            destination_longitude=[11.580],
            output_path="/tmp/matrix.parquet",
            shade_weight=1.8,
            heat_weight=1.4,
            slope_walk_weight=0.7,
        )

        tool = TravelCostMatrixTool()
        with mock.patch.object(tool, "_get_routing_module", return_value=DummyRouting):
            cfg = tool._build_matrix_config(params)
            assert cfg.shade_weight == 1.8
            assert cfg.heat_weight == 1.4
            assert cfg.slope_walk_weight == 0.7


# ---------------------------------------------------------------------------
# Test: Tool Runner Propagation to Analysis Params
# ---------------------------------------------------------------------------


class TestToolRunnerPropagation:
    """Verifies that ToolRunner implementations propagate environmental walkability
    weights from WindmillParams to AnalysisParams.
    """

    def test_catchment_v2_runner_propagates_weights(self, tmp_path: Path) -> None:
        from goatlib.tools.catchment_area_v2 import (
            CatchmentAreaV2ToolRunner,
            CatchmentAreaV2WindmillParams,
        )

        runner = CatchmentAreaV2ToolRunner()
        params = CatchmentAreaV2WindmillParams(
            user_id="test-user",
            routing_mode="walking",
            starting_points=StartingPointsMap(
                latitude=[48.137],
                longitude=[11.576],
            ),
            shade_weight=1.5,
            heat_weight=2.0,
            slope_walk_weight=0.8,
        )
        mock_tool = mock.MagicMock()
        mock_tool.run.return_value = [(tmp_path / "out.parquet", mock.MagicMock())]
        mock_tool_class = mock.MagicMock(return_value=mock_tool)
        with (
            mock.patch.object(
                runner, "_get_starting_coordinates", return_value=([48.137], [11.576])
            ),
            mock.patch.object(runner, "_create_starting_points_parquet"),
            mock.patch.object(runner, "_resolve_origins", side_effect=lambda p, *args: p),
            mock.patch.object(runner, "tool_class", mock_tool_class),
        ):
            runner.process(params, tmp_path)
            assert mock_tool.run.called
            analysis_params = mock_tool.run.call_args[0][0]
            assert analysis_params.shade_weight == 1.5
            assert analysis_params.heat_weight == 2.0
            assert analysis_params.slope_walk_weight == 0.8

    def test_heatmap_v2_runner_propagates_weights(self, tmp_path: Path) -> None:
        from goatlib.analysis.schemas.heatmap_v2 import OpportunityV2
        from goatlib.tools.heatmap_v2 import (
            HeatmapRoutingMode,
            HeatmapV2ToolRunner,
            HeatmapV2WindmillParams,
        )

        runner = HeatmapV2ToolRunner()
        params = HeatmapV2WindmillParams(
            user_id="test-user",
            routing_mode=HeatmapRoutingMode.walking,
            shade_weight=1.2,
            heat_weight=2.5,
            slope_walk_weight=0.6,
        )
        mock_tool = mock.MagicMock()
        mock_tool.run.return_value = [(tmp_path / "out.parquet", mock.MagicMock())]
        mock_tool_class = mock.MagicMock(return_value=mock_tool)
        opp = OpportunityV2(
            layer_id="parks",
            input_path=str(tmp_path / "parks.parquet"),
            weight=1.0,
            max_cost=15,
        )
        with (
            mock.patch.object(runner, "_resolve_reference_area", return_value=None),
            mock.patch.object(runner, "_resolve_opportunities", return_value=[opp]),
            mock.patch.object(runner, "tool_class", mock_tool_class),
        ):
            runner.process(params, tmp_path)
            assert mock_tool.run.called
            analysis_params = mock_tool.run.call_args[0][0]
            assert analysis_params.shade_weight == 1.2
            assert analysis_params.heat_weight == 2.5
            assert analysis_params.slope_walk_weight == 0.6

    def test_travel_cost_matrix_runner_propagates_weights(self, tmp_path: Path) -> None:
        from goatlib.tools.travel_cost_matrix import (
            TravelCostMatrixToolRunner,
            TravelCostMatrixWindmillParams,
        )

        runner = TravelCostMatrixToolRunner()
        params = TravelCostMatrixWindmillParams(
            user_id="test-user",
            origin_layer_id="origin-layer",
            destination_layer_id="destination-layer",
            origin_id_column="id",
            destination_id_column="id",
            routing_mode="walking",
            shade_weight=1.8,
            heat_weight=1.4,
            slope_walk_weight=0.7,
        )
        mock_tool = mock.MagicMock()
        mock_tool_class = mock.MagicMock(return_value=mock_tool)
        with (
            mock.patch.object(
                runner,
                "export_layer_to_parquet",
                return_value=str(tmp_path / "layer.parquet"),
            ),
            mock.patch.object(
                runner,
                "_extract_coordinates_from_parquet",
                side_effect=[
                    ([48.137], [11.576], ["o1"]),
                    ([48.140], [11.580], ["d1"]),
                ],
            ),
            mock.patch.object(runner, "_build_destination_points_parquet"),
            mock.patch.object(runner, "tool_class", mock_tool_class),
        ):
            runner.process(params, tmp_path)
            assert mock_tool.run.called
            analysis_params = mock_tool.run.call_args[0][0]
            assert analysis_params.shade_weight == 1.8
            assert analysis_params.heat_weight == 1.4
            assert analysis_params.slope_walk_weight == 0.7
