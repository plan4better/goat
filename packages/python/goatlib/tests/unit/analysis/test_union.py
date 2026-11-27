"""Test UnionTool with basic self-union and two-layer union."""

import sys
from pathlib import Path

from fixtures.tool_style import U, check_tool_style, tool_params
from goatlib.analysis.geoprocessing.union import UnionTool
from goatlib.analysis.schemas.geoprocessing import UnionParams
from goatlib.tools.union import UnionToolParams, UnionToolRunner

# Test data paths
TEST_DATA_DIR = Path(__file__).parent.parent.parent / "data" / "vector"
RESULT_DIR = Path(__file__).parent.parent.parent / "result"
POLYGONS_FILE = TEST_DATA_DIR / "overlay_polygons.parquet"
BOUNDARY_FILE = TEST_DATA_DIR / "overlay_boundary.parquet"


def test_self_union():
    """Test self-union (dissolve) operation."""
    print("\n🧪 Testing UnionTool self-union (dissolve)...")

    params = UnionParams(
        input_path=str(POLYGONS_FILE),
        output_path=str(RESULT_DIR / "unit_self_union_polygons.parquet"),
    )

    tool = UnionTool()
    result = tool.run(params)

    if result and len(result) == 1:
        output_path, metadata = result[0]
        print(f"✓ Self-union completed: {output_path}")
        print(f"✓ Output metadata: {metadata}")
        print("✅ Self-union test passed!")
    else:
        print("❌ Self-union test failed!")
        sys.exit(1)

    check_tool_style(
        UnionToolRunner,
        tool_params(UnionToolParams, params, input_layer_id=U),
        output_path,
    )


def test_two_layer_union():
    """Test two-layer union operation."""
    print("\n🧪 Testing UnionTool two-layer union...")

    params = UnionParams(
        input_path=str(POLYGONS_FILE),
        overlay_path=str(BOUNDARY_FILE),
        overlay_fields_prefix="boundary_",
        output_path=str(RESULT_DIR / "unit_two_layer_union.parquet"),
    )

    tool = UnionTool()
    result = tool.run(params)

    if result and len(result) == 1:
        output_path, metadata = result[0]
        print(f"✓ Two-layer union completed: {output_path}")
        print(f"✓ Output metadata: {metadata}")
        print("✅ Two-layer union test passed!")
    else:
        print("❌ Two-layer union test failed!")
        sys.exit(1)


if __name__ == "__main__":
    test_self_union()
    test_two_layer_union()
    print("\n✅ All UnionTool tests passed!")
