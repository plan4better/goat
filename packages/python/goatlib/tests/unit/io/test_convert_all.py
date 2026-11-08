"""One unreadable dataset must not cost the others.

An upload can hold many datasets — the layers of a GeoPackage, the files of an archive —
and the interesting case is the mixed one: some convert, some do not, and the caller has
to be able to say which.
"""

import zipfile
from pathlib import Path

import pytest
from goatlib.io.ingest import convert_all, convert_any, dataset_name


def _archive(path: Path, members: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return path


def test_a_broken_dataset_is_reported_and_the_rest_convert(tmp_path):
    archive = _archive(
        tmp_path / "mixed.zip",
        {
            "good/counts.csv": "id,value\n1,42\n2,7\n",
            "bad/broken.geojson": "{ this is not geojson",
        },
    )

    report = convert_all(str(archive), tmp_path / "out")

    assert len(report.outputs) == 1
    assert Path(report.outputs[0].path).exists()
    assert report.outputs[0].name == "counts"
    assert [f.name for f in report.failures] == ["broken"]
    # One line, not a GDAL paragraph with the failing SQL quoted back.
    assert report.failures[0].reason
    assert "\n" not in report.failures[0].reason
    assert report.failures[0].source.endswith("bad/broken.geojson")


def test_every_dataset_converting_leaves_no_failures(tmp_path):
    archive = _archive(
        tmp_path / "clean.zip",
        {"a/one.csv": "id\n1\n", "b/two.csv": "id\n2\n"},
    )

    report = convert_all(str(archive), tmp_path / "out")

    assert len(report.outputs) == 2
    assert report.failures == []


def test_convert_any_still_raises_when_nothing_converts(tmp_path):
    """The strict entry point is unchanged for callers that want one dataset or an error."""
    archive = _archive(tmp_path / "allbad.zip", {"bad/broken.geojson": "{ nope"})

    with pytest.raises(ValueError):
        convert_any(str(archive), tmp_path / "out")


def test_convert_any_returns_what_converted_when_only_some_did(tmp_path):
    """Previously the first failure aborted the lot, losing readable datasets with it."""
    archive = _archive(
        tmp_path / "partial.zip",
        {"good/counts.csv": "id\n1\n", "bad/broken.geojson": "{ nope"},
    )

    outputs = convert_any(str(archive), tmp_path / "out")

    assert len(outputs) == 1


# A WFS connection file.
WFS_CONNECTION_FILE = "<OGRWFSDataSource></OGRWFSDataSource>"


def test_an_xml_member_beside_a_dataset_is_ignored(tmp_path, recorded):
    """`.xml` is no format of an archive member, so a WFS connection file next
    to a dataset is ignored, and on its own it leaves nothing to convert."""
    archive = _archive(
        tmp_path / "layers.zip",
        {
            "layers/wfs.xml": WFS_CONNECTION_FILE,
            "layers/counts.csv": "id,value\n1,42\n",
        },
    )

    report = convert_all(str(archive), tmp_path / "out")

    assert [o.name for o in report.outputs] == ["counts"]
    assert report.failures == []
    assert [s for s in recorded if "ST_Read" in s] == []

    only_xml = _archive(tmp_path / "only.zip", {"layers/wfs.xml": WFS_CONNECTION_FILE})
    with pytest.raises(ValueError, match="No convertible datasets found"):
        convert_all(str(only_xml), tmp_path / "out2")
    assert [s for s in recorded if "ST_Read" in s] == []


def test_an_xml_file_uploaded_on_its_own_is_refused(tmp_path, recorded):
    """A WFS connection file is no upload format: refused before any read."""
    source = tmp_path / "wfs.xml"
    source.write_text(WFS_CONNECTION_FILE)

    report = convert_all(str(source), tmp_path / "out")

    assert report.outputs == []
    assert [f.reason for f in report.failures] == ["Unsupported file format: .xml"]
    assert [s for s in recorded if "ST_Read" in s] == []


@pytest.mark.parametrize(
    ("discovered", "expected"),
    [
        ("/tmp/x/roads.gpkg::tlm_strassen", "tlm_strassen"),
        ("/tmp/x/street_trees.geojson", "street_trees"),
        ("/tmp/x/wien/counts.csv", "counts"),
    ],
)
def test_dataset_name_prefers_the_layer_then_the_file(discovered, expected):
    assert dataset_name(discovered) == expected
