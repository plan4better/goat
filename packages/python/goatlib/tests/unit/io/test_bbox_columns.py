"""Bounding-box columns are recognised by type, not by name."""

from goatlib.io.bbox_columns import is_bbox_struct, star_excluding, stray_bbox_columns


def test_a_struct_of_the_four_bounds_is_a_bbox_column() -> None:
    assert is_bbox_struct("STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)")
    # GDAL's GeoParquet covering column uses FLOAT
    assert is_bbox_struct("STRUCT(xmin FLOAT, ymin FLOAT, xmax FLOAT, ymax FLOAT)")
    assert is_bbox_struct(
        'STRUCT("xmax" DOUBLE, "ymax" DOUBLE, "xmin" DOUBLE, "ymin" DOUBLE)'
    )


def test_other_types_are_not_bbox_columns() -> None:
    assert not is_bbox_struct("DOUBLE")
    assert not is_bbox_struct("VARCHAR")
    assert not is_bbox_struct("STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE)")
    assert not is_bbox_struct(
        "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE, label VARCHAR)"
    )


def test_stray_bbox_columns_are_every_bbox_struct_but_bbox() -> None:
    bounds = "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)"
    rows = [
        ("id", "INTEGER"),
        ("bbox", bounds),
        ("bbox_1", bounds),
        ("geometry_bbox", "STRUCT(xmin FLOAT, ymin FLOAT, xmax FLOAT, ymax FLOAT)"),
        ("bbox_note", "VARCHAR"),
    ]
    assert stray_bbox_columns(rows) == ["bbox_1", "geometry_bbox"]


def test_star_excluding_quotes_the_names() -> None:
    assert star_excluding([]) == "*"
    assert star_excluding(["bbox_1", 'odd"name']) == '* EXCLUDE ("bbox_1", "odd""name")'
