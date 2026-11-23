from goatlib.style.dryrun import DryRunRow, guess_geometry, run

ROWS = [
    DryRunRow(
        "layer_project",
        "1",
        "vector",
        "point",
        "file",
        {"color": [230, 85, 13], "radius": 6, "visibility": True},
    ),
    DryRunRow(
        "layer_project",
        "2",
        "raster",
        None,
        "wms",
        {"opacity": 0.7, "visibility": True},
    ),
    DryRunRow(
        "layer",
        "3",
        "vector",
        "line",
        "file",
        {"stroke_dash_density": "tight", "stroke_pattern": "dashed", "color": "red"},
    ),
    DryRunRow(
        "layer",
        "4",
        "vector",
        "point",
        "file",
        {
            "custom_marker": True,
            "marker": {"url": "https://a/icons/maki/zzz.svg", "name": "zzz"},
        },
    ),
]


def test_counts_lossy_notes_and_unknown_icons() -> None:
    report = run(ROWS)
    assert report.rows == {"layer_project": 2, "layer": 2}
    assert report.exceptions == []
    assert report.lossy["stroke_dash_density"] == ["layer:3"]
    assert report.unknown_icons == {"zzz": 1}
    assert report.errors["unknown_icon"] == ["layer:4"]
    md = report.to_markdown("test")
    assert "| layer_project | 2 |" in md and "zzz" in md


def test_guess_geometry() -> None:
    assert guess_geometry({"radius": 5}) == "point"
    assert guess_geometry({"stroke_pattern": "solid"}) == "line"
    assert guess_geometry({"filled": True, "stroke_color": [1, 2, 3]}) == "polygon"
