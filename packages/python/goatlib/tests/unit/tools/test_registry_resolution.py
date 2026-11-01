"""The registry must hand back the runner a module defines, not one it imports."""

from goatlib.tools.registry import TOOL_REGISTRY


def _entry(name: str):  # noqa: ANN202
    entries = (
        TOOL_REGISTRY.values() if isinstance(TOOL_REGISTRY, dict) else TOOL_REGISTRY
    )
    return next(e for e in entries if e.name == name)


def test_catchment_v2_resolves_to_its_own_runner() -> None:
    """The module imports the v1 runner; alphabetically 'T' < 'V', so a
    name-suffix scan over dir() returned the wrong class."""
    cls = _entry("catchment_area_v2").get_runner_class()
    assert cls is not None
    assert cls.__name__ == "CatchmentAreaV2ToolRunner"


def test_a_runner_not_named_toolrunner_is_still_found() -> None:
    """`LayerExportRunner` used to resolve to the imported SimpleToolRunner."""
    cls = _entry("layer_export").get_runner_class()
    assert cls is not None
    assert cls.__module__ == "goatlib.tools.layer_export"
    assert cls.__name__ != "SimpleToolRunner"


def test_every_registered_tool_resolves_to_a_real_runner() -> None:
    """Never None, never one of the two abstract bases. A thin module
    (`heatmap_gravity_v2`, `bundle_import`) imports the single runner it runs,
    so the class may legitimately live in another module."""
    from goatlib.tools.base import BaseToolRunner, SimpleToolRunner

    entries = (
        TOOL_REGISTRY.values() if isinstance(TOOL_REGISTRY, dict) else TOOL_REGISTRY
    )
    wrong = []
    for e in entries:
        cls = e.get_runner_class()
        if cls is None or cls in (BaseToolRunner, SimpleToolRunner):
            wrong.append((e.name, cls.__name__ if cls else None))
    assert not wrong, wrong


def test_the_thin_heatmap_modules_resolve_to_their_own_v2_runner() -> None:
    gravity = _entry("heatmap_gravity").get_runner_class()
    two_sfca = _entry("heatmap_2sfca").get_runner_class()
    assert gravity is not None and gravity.__name__ == "HeatmapGravityV2ToolRunner"
    assert two_sfca is not None and two_sfca.__name__ == "Heatmap2SFCAV2ToolRunner"


def test_a_tool_predicts_its_output_itself_or_with_the_first_inputs_columns() -> None:
    """A workflow check trusts a prediction only when the tool's runner makes
    it itself: the default passes the first input's columns through, which
    may be any of the step's layers."""
    from goatlib.tools.schema_prediction import predicts_own_output

    assert predicts_own_output("buffer")
    assert predicts_own_output("join")
    assert predicts_own_output("huff_model")
    assert predicts_own_output("huff_model_legacy")
    # Its columns per opportunity are named after each opportunity's name or
    # file, which a prediction cannot know.
    assert not predicts_own_output("heatmap_2sfca_legacy")
    assert not predicts_own_output("layer_delete")
    assert not predicts_own_output("no_such_tool")
