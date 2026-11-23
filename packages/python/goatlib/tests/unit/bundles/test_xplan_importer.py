"""XPlanGML bundles: code lists, spec, import."""

import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import duckdb
import pytest
from goatlib.bundles.importers import infer_bundle_type
from goatlib.bundles.importers.xplan.importer import XPlanImporter
from goatlib.bundles.importers.xplan.schema import CodeList, version_from_namespace
from goatlib.models.bundle import BundleTypeName


def _ring(x: int, y: int, size: int = 10) -> str:
    return f"{x} {y} {x + size} {y} {x + size} {y + size} {x} {y + size} {x} {y}"


def _polygon(gid: str, x: int, y: int) -> str:
    return (
        f'<gml:Polygon gml:id="{gid}" srsName="EPSG:25832"><gml:exterior>'
        f"<gml:LinearRing><gml:posList>{_ring(x, y)}</gml:posList></gml:LinearRing>"
        "</gml:exterior></gml:Polygon>"
    )


# An area whose east side is an arc, as plans draw rounded corners.
ARC_POLYGON = (
    '<gml:Polygon gml:id="g_arc" srsName="EPSG:25832"><gml:exterior><gml:Ring>'
    '<gml:curveMember><gml:Curve gml:id="c_arc"><gml:segments>'
    "<gml:LineStringSegment><gml:posList>40 0 50 0</gml:posList></gml:LineStringSegment>"
    "<gml:Arc><gml:posList>50 0 55 5 50 10</gml:posList></gml:Arc>"
    "<gml:LineStringSegment><gml:posList>50 10 40 10 40 0</gml:posList></gml:LineStringSegment>"
    "</gml:segments></gml:Curve></gml:curveMember></gml:Ring></gml:exterior></gml:Polygon>"
)

_BOUNDS = (
    '<gml:boundedBy><gml:Envelope srsName="EPSG:25832"><gml:lowerCorner>0 0</gml:lowerCorner>'
    "<gml:upperCorner>70 10</gml:upperCorner></gml:Envelope></gml:boundedBy>"
)

MEMBERS = [
    '<xplan:BP_Plan gml:id="PLAN"><xplan:name>T1</xplan:name>'
    f"<xplan:raeumlicherGeltungsbereich>{_polygon('g_plan', 0, 0)}</xplan:raeumlicherGeltungsbereich>"
    "<xplan:gemeinde><xplan:XP_Gemeinde><xplan:ags>05314000</xplan:ags>"
    "</xplan:XP_Gemeinde></xplan:gemeinde>"
    "<xplan:planArt>1000</xplan:planArt><xplan:rechtsstand>3000</xplan:rechtsstand>"
    "<xplan:inkrafttretensDatum>2020-01-02</xplan:inkrafttretensDatum>"
    '<xplan:bereich xlink:href="#BER"/></xplan:BP_Plan>',
    '<xplan:BP_Bereich gml:id="BER"><xplan:nummer>0</xplan:nummer>'
    f"<xplan:geltungsbereich>{_polygon('g_ber', 0, 0)}</xplan:geltungsbereich>"
    '<xplan:gehoertZuPlan xlink:href="#PLAN"/></xplan:BP_Bereich>',
    '<xplan:BP_BaugebietsTeilFlaeche gml:id="A1">'
    + _BOUNDS
    + '<xplan:gehoertZuBereich xlink:href="#BER"/><xplan:rechtscharakter>1000</xplan:rechtscharakter>'
    '<xplan:refTextInhalt xlink:href="#TXT1"/>'
    f"<xplan:position>{_polygon('g_a1', 0, 0)}</xplan:position>"
    "<xplan:flaechenschluss>true</xplan:flaechenschluss><xplan:GRZ>0.6</xplan:GRZ>"
    "<xplan:besondereArtDerBaulNutzung>1500</xplan:besondereArtDerBaulNutzung>"
    "<xplan:bauweise>2000</xplan:bauweise></xplan:BP_BaugebietsTeilFlaeche>",
    '<xplan:BP_BaugebietsTeilFlaeche gml:id="A2">'
    '<xplan:gehoertZuBereich xlink:href="#BER"/><xplan:rechtscharakter>1000</xplan:rechtscharakter>'
    f"<xplan:position>{ARC_POLYGON}</xplan:position>"
    "<xplan:flaechenschluss>true</xplan:flaechenschluss>"
    "<xplan:besondereArtDerBaulNutzung>9998</xplan:besondereArtDerBaulNutzung>"
    "</xplan:BP_BaugebietsTeilFlaeche>",
    '<xplan:BP_GruenFlaeche gml:id="G1">'
    '<xplan:gehoertZuBereich xlink:href="#BER"/><xplan:rechtscharakter>1000</xplan:rechtscharakter>'
    f"<xplan:position>{_polygon('g_g1', 20, 0)}</xplan:position>"
    "<xplan:flaechenschluss>true</xplan:flaechenschluss>"
    "<xplan:zweckbestimmung>1000</xplan:zweckbestimmung>"
    "<xplan:zweckbestimmung>1200</xplan:zweckbestimmung></xplan:BP_GruenFlaeche>",
    '<xplan:BP_BauGrenze gml:id="L1">'
    '<xplan:gehoertZuBereich xlink:href="#BER"/><xplan:rechtscharakter>1000</xplan:rechtscharakter>'
    '<xplan:position><gml:LineString gml:id="g_l1" srsName="EPSG:25832">'
    "<gml:posList>1 1 9 1 9 9</gml:posList></gml:LineString></xplan:position>"
    "</xplan:BP_BauGrenze>",
    '<xplan:BP_TextAbschnitt gml:id="TXT1"><xplan:schluessel>§2 Nr.2</xplan:schluessel>'
    "<xplan:text>Im Mischgebiet sind Einzelhandelsbetriebe unzulässig.</xplan:text>"
    "<xplan:rechtscharakter>1000</xplan:rechtscharakter></xplan:BP_TextAbschnitt>",
    '<xplan:XP_PPO gml:id="PPO1"><xplan:position><gml:Point gml:id="g_ppo" srsName="EPSG:25832">'
    "<gml:pos>5 5</gml:pos></gml:Point></xplan:position>"
    '<xplan:dientZurDarstellungVon xlink:href="#A1"/></xplan:XP_PPO>',
    '<xplan:SO_Denkmalschutzrecht gml:id="D1">'
    '<xplan:gehoertZuBereich xlink:href="#BER"/><xplan:rechtscharakter>1000</xplan:rechtscharakter>'
    '<xplan:position><gml:Point gml:id="g_d1" srsName="EPSG:25832"><gml:pos>2 2</gml:pos>'
    "</gml:Point></xplan:position><xplan:flaechenschluss>false</xplan:flaechenschluss>"
    "<xplan:artDerFestlegung>1000</xplan:artDerFestlegung></xplan:SO_Denkmalschutzrecht>",
    '<xplan:SO_Denkmalschutzrecht gml:id="D2">'
    '<xplan:gehoertZuBereich xlink:href="#BER"/><xplan:rechtscharakter>1000</xplan:rechtscharakter>'
    f"<xplan:position>{_polygon('g_d2', 60, 0)}</xplan:position>"
    "<xplan:flaechenschluss>false</xplan:flaechenschluss>"
    "<xplan:artDerFestlegung>1000</xplan:artDerFestlegung></xplan:SO_Denkmalschutzrecht>",
]

_NS = (
    'xmlns:xplan="http://www.xplanung.de/xplangml/5/1" '
    'xmlns:gml="http://www.opengis.net/gml/3.2" '
    'xmlns:xlink="http://www.w3.org/1999/xlink"'
)

XPLAN_51 = (
    f'<?xml version="1.0" encoding="UTF-8"?>\n<xplan:XPlanAuszug {_NS} gml:id="AUSZUG">'
    + _BOUNDS
    + "".join(f"<gml:featureMember>{m}</gml:featureMember>" for m in MEMBERS)
    + "</xplan:XPlanAuszug>"
)

_XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"'

# The same plan as an XPlan WFS download service delivers it (Hamburg's
# HH_WFS_xplan_dls): the plan as the one member, its objects as additional
# objects, and the xlink namespace declared on each link, not on the root.
XPLAN_51_WFS = (
    '<?xml version="1.0" encoding="UTF-8"?>\n<wfs:FeatureCollection '
    f'xmlns:wfs="http://www.opengis.net/wfs/2.0" {_NS.replace(_XLINK, "")}>'
    + _BOUNDS
    + f"<wfs:member>{MEMBERS[0]}</wfs:member>".replace(
        "xlink:href=", f"{_XLINK} xlink:href="
    )
    + "<wfs:additionalObjects><wfs:SimpleFeatureCollection>"
    + "".join(
        f"<wfs:member>{m}</wfs:member>".replace("xlink:href=", f"{_XLINK} xlink:href=")
        for m in MEMBERS[1:]
    )
    + "</wfs:SimpleFeatureCollection></wfs:additionalObjects>"
    + "</wfs:FeatureCollection>"
)

# A GML of another kind that only mentions the XPlanung namespace in a comment.
NOT_XPLAN = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    "<!-- converted from http://www.xplanung.de/xplangml/5/1 -->\n"
    '<t:Collection xmlns:t="http://example.org/t" xmlns:gml="http://www.opengis.net/gml/3.2" '
    'gml:id="c"><gml:featureMember><t:A gml:id="a1"><t:geom><gml:Point gml:id="p1" '
    'srsName="EPSG:25832"><gml:pos>1 2</gml:pos></gml:Point></t:geom></t:A>'
    "</gml:featureMember></t:Collection>"
)


def _write(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path


def _roles(layers) -> set[str]:
    return {layer.role for layer in layers}


def _rows(layer) -> list[dict]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    reader = (
        f"read_parquet('{layer.file_path}')"
        if layer.file_path.endswith(".parquet")
        else f"ST_Read('{layer.file_path}')"
    )
    cursor = con.execute(f"SELECT * FROM {reader}")
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


@pytest.fixture
def layers(tmp_path: Path):
    source = _write(tmp_path, "t1.gml", XPLAN_51)
    workdir = tmp_path / "work"
    workdir.mkdir()
    return {
        layer.role: layer
        for layer in XPlanImporter().extract_layers(str(source), str(workdir))
    }


def test_importers_load_without_pyarrow():
    """Core imports the importers but installs goatlib without pyarrow and
    pyogrio: XPlan loads them only when a plan is read."""
    code = (
        "import sys; sys.modules['pyarrow'] = sys.modules['pyogrio'] = None; "
        "import goatlib.bundles.importers"
    )
    subprocess.run([sys.executable, "-c", code], check=True)


def test_codes_decode():
    codes = CodeList()
    assert codes.name("6.0", "XP_BesondereArtDerBaulNutzung", "1500") == "Mischgebiet"
    assert (
        codes.name("6.0", "XP_BesondereArtDerBaulNutzung", "1550") == "Urbanes Gebiet"
    )


def test_field_lists():
    codes = CodeList()
    cls = "BP_BaugebietsTeilFlaeche"
    assert codes.field_list("5.1", cls, "besondereArtDerBaulNutzung") == (
        "XP_BesondereArtDerBaulNutzung"
    )
    assert codes.field_list("5.1", cls, "bauweise") == "BP_Bauweise"


def test_unknown_code_is_none():
    assert CodeList().name("6.0", "XP_BesondereArtDerBaulNutzung", "9998") is None


def test_version_from_namespace():
    assert version_from_namespace("http://www.xplanung.de/xplangml/5/4") == "5.4"
    assert version_from_namespace("http://www.opengis.net/citygml/2.0") is None


def test_xplan_spec():
    """One type, no member list: a plan holds whichever of the standard's
    classes it uses, and each layer is tagged with its class (`role`)."""
    from goatlib.models.bundle import get_spec

    spec = get_spec("xplan")
    assert spec.roles == ()
    assert spec.artifacts == ()


def test_xplan_is_sniffed(tmp_path: Path):
    importer = XPlanImporter()
    plan = _write(tmp_path, "t1.gml", XPLAN_51)
    wfs = _write(tmp_path, "wfs.gml", XPLAN_51_WFS)
    other = _write(tmp_path, "other.gml", NOT_XPLAN)
    assert importer.matches_source(str(plan))
    assert importer.matches_source(str(wfs))
    assert not importer.matches_source(str(other))
    assert infer_bundle_type("t1.gml", str(plan)) == BundleTypeName.xplan
    assert infer_bundle_type("other.gml", str(other)) is None
    # Declared without a prefix, in single quotes, or with spaces around `=`.
    for n, declaration in enumerate(
        (
            'xmlns="http://www.xplanung.de/xplangml/5/4"',
            "xmlns:xp='http://www.xplanung.de/xplangml/5/4'",
            'xmlns:xp = "http://www.xplanung.de/xplangml/5/4"',
        )
    ):
        head = _write(tmp_path, f"d{n}.gml", f"<XPlanAuszug {declaration}/>")
        assert importer.matches_source(str(head)), declaration


def test_xplan_layers(layers):
    assert set(layers) == {
        "BP_Plan",
        "BP_Bereich",
        "BP_BaugebietsTeilFlaeche",
        "BP_GruenFlaeche",
        "BP_BauGrenze",
        "text",
        "SO_Denkmalschutzrecht:point",
        "SO_Denkmalschutzrecht:polygon",
    }
    assert layers["text"].layer_type == "table"
    # Each object's own bounding box is not data.
    assert "lowerCorner" not in _rows(layers["BP_BaugebietsTeilFlaeche"])[0]
    assert len(_rows(layers["BP_BaugebietsTeilFlaeche"])) == 2


def test_arcs_become_lines(layers):
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    path = layers["BP_BaugebietsTeilFlaeche"].file_path
    types = con.execute(
        f"SELECT DISTINCT ST_GeometryType(geom) FROM ST_Read('{path}')"
    ).fetchall()
    assert {t[0] for t in types} <= {"POLYGON", "MULTIPOLYGON"}


def test_wfs_wrapper_same_layers(tmp_path: Path, layers):
    source = _write(tmp_path, "wfs.gml", XPLAN_51_WFS)
    workdir = tmp_path / "work_wfs"
    workdir.mkdir()
    wfs = {
        layer.role: layer
        for layer in XPlanImporter().extract_layers(str(source), str(workdir))
    }
    assert set(wfs) == set(layers)
    assert {r: len(_rows(layer)) for r, layer in wfs.items()} == {
        r: len(_rows(layer)) for r, layer in layers.items()
    }
    area = _by_id(wfs["BP_BaugebietsTeilFlaeche"])["A1"]
    assert area["refTextInhaltWert"].startswith("§2 Nr.2 | ")
    assert area["xpPlanName"] == "T1"


def _by_id(layer) -> dict[str, dict]:
    return {row["gml_id"]: row for row in _rows(layer)}


def test_codes_become_wert_columns(layers):
    areas = _by_id(layers["BP_BaugebietsTeilFlaeche"])
    assert areas["A1"]["besondereArtDerBaulNutzungWert"] == "Mischgebiet"
    assert areas["A1"]["bauweiseWert"] == "Geschlossene Bauweise"
    assert areas["A2"]["besondereArtDerBaulNutzungWert"] is None


def test_clause_text_on_area(layers):
    text = _by_id(layers["BP_BaugebietsTeilFlaeche"])["A1"]["refTextInhaltWert"]
    assert text.startswith("§2 Nr.2 | ")
    assert "Einzelhandelsbetriebe unzulässig" in text


def test_plan_columns(layers):
    for layer in layers.values():
        for row in _rows(layer):
            assert row["xpPlanName"] == "T1"
            assert row["xpVersion"] == "5.1"
            assert row["xpPlanType"] == "BP_Plan"
            assert row["xpRechtsstand"] == "Satzung"
            assert row["xpAgs"] == "05314000"


def test_list_code_decodes_each(layers):
    green = _by_id(layers["BP_GruenFlaeche"])["G1"]
    assert green["zweckbestimmungWert"] == "Parkanlage; Dauerkleingarten"


def test_xlink_declared_on_root(tmp_path: Path):
    """GDAL keeps links only for some files whose root does not declare xlink
    (Hamburg's WFS downloads); the importer reads a copy that declares it."""
    from goatlib.bundles.importers.xplan.importer import copy_with_root_xlink

    target = tmp_path / "copy.gml"
    copy_with_root_xlink(_write(tmp_path, "wfs.gml", XPLAN_51_WFS), target)
    fixed = target.read_bytes()
    root = fixed[fixed.index(b"<wfs:FeatureCollection") :].split(b">", 1)[0]
    assert root.count(b"xmlns:xlink") == 1
    assert fixed.endswith(b"</wfs:FeatureCollection>")
    copy_with_root_xlink(_write(tmp_path, "t1.gml", XPLAN_51), target)
    assert target.read_bytes() == XPLAN_51.encode()


def test_upload_saved_under_another_name(tmp_path: Path):
    """The worker saves the upload as `<tmp>.zip`; it is still a plan."""
    source = _write(tmp_path, "upload.zip", XPLAN_51)
    workdir = tmp_path / "work"
    workdir.mkdir()
    assert XPlanImporter().validate(str(source)).valid
    roles = {
        layer.role
        for layer in XPlanImporter().extract_layers(str(source), str(workdir))
    }
    assert "BP_BaugebietsTeilFlaeche" in roles


def _archive(path: Path, members: dict, *, stored: bool = False) -> Path:
    method = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(path, "w", method) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return path


@pytest.fixture
def unpacked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The directory archives are unpacked into, and GML files linked into:
    whatever a test leaves there, an import leaves on a worker."""
    directory = tmp_path / "unpacked"
    directory.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(directory))
    return directory


@pytest.mark.parametrize("stored", [False, True])
def test_a_zipped_plan_is_the_plan(tmp_path: Path, unpacked: Path, layers, stored):
    """A plan's archive holds the plan as `xplan.gml`, with its documents
    beside it. Compressed or not: the start of an archive that only stores
    its members reads like the plan itself."""
    source = _archive(
        tmp_path / "upload.zip",
        {"xplan.gml": XPLAN_51, "BPlan.pdf": b"%PDF-1.7", "BPlan.png": b"png"},
        stored=stored,
    )
    importer = XPlanImporter()
    assert importer.matches_source(str(source))
    assert infer_bundle_type("BPlan004_5-1.zip", str(source)) == BundleTypeName.xplan

    validation = importer.validate(str(source))
    assert validation.valid, validation.errors
    assert "BP_BaugebietsTeilFlaeche" in validation.detected_roles

    workdir = tmp_path / "zipped"
    workdir.mkdir()
    zipped = {
        layer.role: layer
        for layer in importer.extract_layers(str(source), str(workdir))
    }
    assert set(zipped) == set(layers)
    area = "BP_BaugebietsTeilFlaeche"
    assert _by_id(zipped[area]) == _by_id(layers[area])
    assert list(unpacked.iterdir()) == []


def test_an_archive_without_a_plan_is_no_plan(tmp_path: Path, unpacked: Path):
    """Any other archive stays what it was: a dataset upload, or another
    bundle type's."""
    source = _archive(
        tmp_path / "upload.zip", {"parcels.gml": XPLAN_51, "readme.txt": "notes"}
    )
    importer = XPlanImporter()
    assert not importer.matches_source(str(source))
    assert infer_bundle_type("parcels.zip", str(source)) is None
    validation = importer.validate(str(source))
    assert not validation.valid
    assert "no xplan.gml" in validation.errors[0]
    assert list(unpacked.iterdir()) == []


def test_an_archive_with_two_plans_is_refused(tmp_path: Path, unpacked: Path):
    source = _archive(
        tmp_path / "upload.zip", {"a/xplan.gml": XPLAN_51, "b/xplan.gml": XPLAN_51}
    )
    validation = XPlanImporter().validate(str(source))
    assert not validation.valid
    assert "more than one" in validation.errors[0]
    assert list(unpacked.iterdir()) == []


@pytest.mark.parametrize(
    "members",
    [
        {"xplan.gml": XPLAN_51, "../x.gml": XPLAN_51},
        {"../xplan.gml": XPLAN_51},
        {"xplan.gml": XPLAN_51, "docs/../../x.gml": XPLAN_51},
    ],
)
def test_an_archive_member_outside_the_archive_is_refused(
    tmp_path: Path, unpacked: Path, members: dict
):
    """An archive is unpacked by the dataset upload's own handling, which
    refuses a member whose path leaves the archive; so is the plan in it."""
    source = _archive(tmp_path / "upload.zip", members)
    importer = XPlanImporter()

    validation = importer.validate(str(source))
    assert not validation.valid
    assert "escapes the archive" in validation.errors[0]

    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(ValueError, match="escapes the archive"):
        importer.extract_layers(str(source), str(workdir))
    assert list(workdir.iterdir()) == []
    # Nothing was written beside the directory it was unpacked into either.
    assert list(unpacked.iterdir()) == []
    assert not list(tmp_path.glob("x.gml")) and not list(tmp_path.glob("xplan.gml"))


def test_an_archive_larger_than_the_upload_limit_is_refused(
    tmp_path: Path, unpacked: Path
):
    """The same limit on an archive's unpacked size as for a dataset upload,
    checked before anything is unpacked."""
    from goatlib.io.discover import ZIP_MAX_UNPACKED_BYTES

    source = tmp_path / "upload.zip"
    megabyte = bytes(1024 * 1024)
    with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xplan.gml", XPLAN_51)
        with archive.open("BPlan.tif", "w", force_zip64=True) as raster:
            for _ in range(ZIP_MAX_UNPACKED_BYTES // len(megabyte) + 1):
                raster.write(megabyte)
    assert source.stat().st_size < 2 * 1024 * 1024
    importer = XPlanImporter()

    validation = importer.validate(str(source))
    assert not validation.valid
    assert "too large" in validation.errors[0]

    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(ValueError, match="too large"):
        importer.extract_layers(str(source), str(workdir))
    assert list(unpacked.iterdir()) == []


#: A published plan, unchanged (source and licence: tests/data/xplan/README.md).
REAL_PLAN = (
    Path(__file__).parents[2] / "data" / "xplan" / "bplan_39_6_aenderung_5-3.gml"
)


def test_a_published_plan_imports(tmp_path: Path):
    """A development plan as a state's plan server hands it out (XPlanGML 5.3
    in a WFS collection): every object of the file arrives, with what the
    file states about it in words."""
    text = REAL_PLAN.read_text(encoding="utf-8")
    importer = XPlanImporter()
    assert infer_bundle_type(REAL_PLAN.name, str(REAL_PLAN)) == BundleTypeName.xplan
    validation = importer.validate(str(REAL_PLAN))
    assert validation.valid, validation.errors

    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = {
        layer.role: layer
        for layer in importer.extract_layers(str(REAL_PLAN), str(workdir))
    }
    classes = (
        "BP_Plan",
        "BP_Bereich",
        "BP_BaugebietsTeilFlaeche",
        "BP_BauGrenze",
        "BP_UeberbaubareGrundstuecksFlaeche",
    )
    # The label placements (XP_PPO) are not plan data; the clauses are one table.
    assert set(layers) == {*classes, "text"}
    for cls in classes:
        assert len(_rows(layers[cls])) == text.count(f"<xplan:{cls} "), cls
    assert len(_rows(layers["text"])) == text.count("<xplan:BP_TextAbschnitt ") == 7

    (area,) = _rows(layers["BP_BaugebietsTeilFlaeche"])
    # The file states 1500, 2000, 0.6 and 2.
    assert area["besondereArtDerBaulNutzungWert"] == "Mischgebiet"
    # Names are the code lists' own, which the standard spells without umlauts.
    assert area["allgArtDerBaulNutzungWert"] == "Gemischte Bauflaeche"
    assert area["xpPlanName"] == "Bebauungsplan Nr. 39, 6. Änderung"
    # A municipality key is a code: its leading zero stays, and the blank the
    # file has after it does not (a key is compared and joined on).
    assert area["xpAgs"] == "01062061"
    (buildable,) = _rows(layers["BP_UeberbaubareGrundstuecksFlaeche"])
    assert buildable["GRZ"] == pytest.approx(0.6)
    assert buildable["Z"] == 2
    assert buildable["bauweiseWert"] == "Offene Bauweise"
    assert layers["BP_BauGrenze"].geometry_type == "line"
    # Nothing is written beside the plan.
    assert sorted(p.name for p in REAL_PLAN.parent.iterdir()) == [
        "README.md",
        REAL_PLAN.name,
    ]


def test_root_xlink_in_single_quotes(tmp_path: Path):
    source = _write(
        tmp_path,
        "t1.gml",
        XPLAN_51.replace(_XLINK, "xmlns:xlink='http://www.w3.org/1999/xlink'", 1),
    )
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = {
        layer.role: layer
        for layer in XPlanImporter().extract_layers(str(source), str(workdir))
    }
    assert _by_id(layers["BP_BaugebietsTeilFlaeche"])["A1"]["refTextInhaltWert"]


def test_objects_without_a_plan_import(tmp_path: Path):
    """An XPlan WFS can deliver one class alone, with no plan object."""
    areas = [m for m in MEMBERS if "BP_BaugebietsTeilFlaeche" in m]
    content = (
        XPLAN_51.split("<gml:featureMember>", 1)[0]
        + "".join(f"<gml:featureMember>{m}</gml:featureMember>" for m in areas)
        + "</xplan:XPlanAuszug>"
    )
    source = _write(tmp_path, "areas.gml", content)
    workdir = tmp_path / "work"
    workdir.mkdir()
    assert XPlanImporter().validate(str(source)).valid
    layers = {
        layer.role: layer
        for layer in XPlanImporter().extract_layers(str(source), str(workdir))
    }
    assert set(layers) == {"BP_BaugebietsTeilFlaeche"}
    assert _by_id(layers["BP_BaugebietsTeilFlaeche"])["A1"]["xpPlanName"] is None


def test_nothing_readable_fails(tmp_path: Path):
    """A plan whose objects all only place labels has nothing to import, and
    an empty bundle must not report success."""
    labels = [m for m in MEMBERS if "XP_PPO" in m]
    content = (
        XPLAN_51.split("<gml:featureMember>", 1)[0]
        + "".join(f"<gml:featureMember>{m}</gml:featureMember>" for m in labels)
        + "</xplan:XPlanAuszug>"
    )
    source = _write(tmp_path, "labels.gml", content)
    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(ValueError, match="no plan objects"):
        XPlanImporter().extract_layers(str(source), str(workdir))


def test_content_of_another_format_is_not_read(tmp_path: Path):
    """A plan is read by the GML driver alone. A file of another format that
    declares the XPlan namespace is sniffed as a plan, and then refused: it is
    not read through that other format's driver."""
    other = tmp_path / "other.csv"
    other.write_text("a\n1\n")
    source = tmp_path / "plan.gml"
    source.write_text(
        '<OGRVRTDataSource xmlns:xplan="http://www.xplanung.de/xplangml/5/1" '
        'xmlns:gml="http://www.opengis.net/gml/3.2">'
        f'<OGRVRTLayer name="BP_Plan"><SrcDataSource>{other}</SrcDataSource>'
        "</OGRVRTLayer></OGRVRTDataSource>"
    )
    importer = XPlanImporter()

    assert importer.matches_source(str(source))
    assert importer.validate(str(source)).valid is False
    work = tmp_path / "work"
    work.mkdir()
    with pytest.raises(ValueError):
        importer.extract_layers(str(source), str(work))
    assert not list(work.glob("*.parquet")) and not list(work.glob("*.gpkg"))


def test_a_plan_is_read_without_a_second_gdal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The plan is read by the GDAL in DuckDB's spatial extension."""
    monkeypatch.setitem(sys.modules, "pyogrio", None)
    source = tmp_path / "plan.gml"
    source.write_text(XPLAN_51)
    work = tmp_path / "work"
    work.mkdir()

    layers = XPlanImporter().extract_layers(str(source), str(work))

    assert {layer.role for layer in layers} >= {"BP_Plan", "BP_BaugebietsTeilFlaeche"}


def _extract(tmp_path: Path, content: str) -> dict:
    source = _write(tmp_path, "plan.gml", content)
    workdir = tmp_path / "work"
    workdir.mkdir()
    return {
        layer.role: layer
        for layer in XPlanImporter().extract_layers(str(source), str(workdir))
    }


def test_a_plan_of_several_municipalities_lists_their_keys(tmp_path: Path):
    """A plan may lie in several municipalities: every object names all of
    their keys, as the other fields with several values do."""
    second = (
        "<xplan:gemeinde><xplan:XP_Gemeinde><xplan:ags>05315000</xplan:ags>"
        "</xplan:XP_Gemeinde></xplan:gemeinde><xplan:planArt>"
    )
    layers = _extract(tmp_path, XPLAN_51.replace("<xplan:planArt>", second, 1))

    for role in ("BP_Plan", "BP_BaugebietsTeilFlaeche", "text"):
        assert {row["xpAgs"] for row in _rows(layers[role])} == {"05314000; 05315000"}


def test_a_key_is_written_without_the_blanks_around_it(tmp_path: Path):
    """Plans from practice state a key with a blank after it; the objects
    carry the key itself, which is what it is compared and joined on."""
    spaced = XPLAN_51.replace(
        "<xplan:ags>05314000</xplan:ags>", "<xplan:ags>05314000 </xplan:ags>", 1
    )
    assert spaced != XPLAN_51
    layers = _extract(tmp_path, spaced)

    for role in ("BP_Plan", "BP_BaugebietsTeilFlaeche"):
        assert {row["xpAgs"] for row in _rows(layers[role])} == {"05314000"}


@pytest.mark.parametrize("version", ["4/1", "6/2", "7/0"])
def test_a_version_without_code_lists_is_refused(tmp_path: Path, version: str):
    """GOAT decodes a plan with the code lists of its version. A version it
    has none for would import with every code left a number and a style
    reading fields the layers do not have, so it is refused, naming the
    versions that are read."""
    source = _write(
        tmp_path, "plan.gml", XPLAN_51.replace("xplangml/5/1", f"xplangml/{version}")
    )
    importer = XPlanImporter()

    result = importer.validate(str(source))

    assert result.valid is False
    assert version.replace("/", ".") in result.errors[0]
    assert "5.0" in result.errors[0] and "6.1" in result.errors[0]
    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(ValueError):
        importer.extract_layers(str(source), str(workdir))


def test_every_version_has_a_look_for_roads_water_and_building_areas():
    """XPlanGML 6 moved roads and water from the plan kinds' own classes to
    shared ones: whichever class a version uses for them has the look."""
    from goatlib.bundles.importers.xplan.schema import SUPPORTED_VERSIONS
    from goatlib.bundles.importers.xplan.schema import classes as version_classes
    from goatlib.bundles.importers.xplan.styles import XPLAN_CLASS_STYLES

    kinds = {
        "roads": ("BP_StrassenVerkehrsFlaeche", "SO_Strassenverkehr"),
        "water": ("BP_GewaesserFlaeche", "SO_Gewaesser"),
        "water management": ("BP_WasserwirtschaftsFlaeche", "SO_Wasserwirtschaft"),
        "building areas": ("BP_BaugebietsTeilFlaeche",),
    }
    for version in SUPPORTED_VERSIONS:
        defined = version_classes(version)
        for kind, candidates in kinds.items():
            used = [c for c in candidates if c in defined]
            assert used, (version, kind)
            assert all(c in XPLAN_CLASS_STYLES for c in used), (version, kind, used)
    road = XPLAN_CLASS_STYLES["BP_StrassenVerkehrsFlaeche"]
    assert XPLAN_CLASS_STYLES["SO_Strassenverkehr"] == road


def test_an_area_without_a_known_use_is_not_drawn_as_mixed_use():
    """An area whose code its version's list does not hold (a municipality's
    own code) has no kind of use: it gets the grey of an unstyled class, not
    the colour of one of the kinds."""
    from goatlib.bundles.importers.xplan.styles import LAND_USE_COLORS, UNSTYLED_GREY
    from goatlib.tools.style import bundle_role_style

    area = bundle_role_style("xplan", "BP_BaugebietsTeilFlaeche", "polygon")

    assert area["symbol"]["fill"]["color"] == UNSTYLED_GREY
    assert UNSTYLED_GREY not in LAND_USE_COLORS.values()


_SCHEMA = """<schema xmlns="http://www.w3.org/2001/XMLSchema"
  xmlns:xplan="http://www.xplanung.de/xplangml/6/0" xmlns:gml="http://www.opengis.net/gml/3.2">
  <element name="XP_Objekt" type="xplan:XP_ObjektType" abstract="true"
    substitutionGroup="gml:AbstractFeature"/>
  <complexType name="XP_ObjektType"><complexContent><extension base="gml:AbstractFeatureType">
    <sequence><element name="rechtscharakter" type="xplan:XP_Rechtscharakter"/></sequence>
  </extension></complexContent></complexType>
  <element name="BP_GruenFlaeche" type="xplan:BP_GruenFlaecheType"
    substitutionGroup="xplan:XP_Objekt"/>
  <complexType name="BP_GruenFlaecheType"><complexContent>
    <extension base="xplan:XP_ObjektType"><sequence>
      <element name="zweckbestimmung" type="xplan:BP_KomplexeZweckbestGruenPropertyType"/>
      <element name="nutzungsform" type="xplan:XP_Nutzungsform"/>
      <element name="hoehe" type="xplan:XP_HoehenangabePropertyType"/>
      <element name="eigentuemer" type="xplan:XP_AkteurPropertyType"/>
      <element name="nachbar" type="xplan:XP_AnliegerPropertyType"/>
    </sequence></extension></complexContent></complexType>
  <element name="BP_KomplexeZweckbestGruen" type="xplan:BP_KomplexeZweckbestGruenType"/>
  <complexType name="BP_KomplexeZweckbestGruenType"><sequence>
    <element name="allgemein" type="xplan:XP_ZweckbestimmungGruen"/>
    <element name="status" type="xplan:XP_Rolle"/>
    <element name="quelle" type="xplan:XP_QuellePropertyType"/>
  </sequence></complexType>
  <element name="XP_Quelle" type="xplan:XP_QuelleType"/>
  <complexType name="XP_QuelleType"><sequence>
    <element name="herkunft" type="xplan:XP_Rolle"/></sequence></complexType>
  <complexType name="XP_QuellePropertyType"><sequence>
    <element ref="xplan:XP_Quelle"/></sequence></complexType>
  <complexType name="BP_KomplexeZweckbestGruenPropertyType"><sequence>
    <element ref="xplan:BP_KomplexeZweckbestGruen"/></sequence></complexType>
  <element name="XP_Hoehenangabe" type="xplan:XP_HoehenangabeType"/>
  <complexType name="XP_HoehenangabeType"><sequence>
    <element name="nutzungsform" type="xplan:XP_ArtHoehenbezug"/>
  </sequence></complexType>
  <complexType name="XP_HoehenangabePropertyType"><sequence>
    <element ref="xplan:XP_Hoehenangabe"/></sequence></complexType>
  <element name="XP_Akteur" type="xplan:XP_AkteurType"/>
  <complexType name="XP_AkteurType"><sequence>
    <element name="rolle" type="xplan:XP_Rolle"/>
    <element name="status" type="string"/></sequence></complexType>
  <complexType name="XP_AkteurPropertyType"><sequence>
    <element ref="xplan:XP_Akteur"/></sequence></complexType>
  <element name="XP_Anlieger" type="xplan:XP_AnliegerType"/>
  <complexType name="XP_AnliegerType"><sequence>
    <element name="rolle" type="xplan:XP_Nutzungsform"/></sequence></complexType>
  <complexType name="XP_AnliegerPropertyType"><sequence>
    <element ref="xplan:XP_Anlieger"/></sequence></complexType>
</schema>
"""


def test_the_schema_holds_the_code_fields_of_a_class_data_types(tmp_path: Path):
    """From XPlanGML 6 a green area states its purpose inside a data type
    (`zweckbestimmung/BP_KomplexeZweckbestGruen/allgemein`). GDAL reads such a
    field under its innermost name, so the class's code fields list it under
    that name, also for a data type inside a data type. A name that is not
    one field's alone is left out (the class itself has a field of that name,
    or another of its data types has one, a code or not): a column of that
    name may be either, and decoding never guesses."""
    import zipfile

    from goatlib.bundles.importers.xplan.generate_schema import classes

    archive = tmp_path / "schema.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("XPlanGML.xsd", _SCHEMA)
    lists = {
        "XP_Rechtscharakter",
        "XP_ZweckbestimmungGruen",
        "XP_Nutzungsform",
        "XP_ArtHoehenbezug",
        "XP_Rolle",
    }

    with zipfile.ZipFile(archive) as z:
        found = classes(z, lists)

    # Only the feature class: the data types are no classes of a file.
    assert set(found) == {"BP_GruenFlaeche"}
    assert found["BP_GruenFlaeche"] == {
        "rechtscharakter": "XP_Rechtscharakter",
        "nutzungsform": "XP_Nutzungsform",
        "allgemein": "XP_ZweckbestimmungGruen",
        "herkunft": "XP_Rolle",
    }


def test_a_version_6_plan_decodes_the_codes_inside_data_types(tmp_path: Path):
    plan = XPLAN_51.replace("xplangml/5/1", "xplangml/6/0").replace(
        "<xplan:zweckbestimmung>1000</xplan:zweckbestimmung>"
        "<xplan:zweckbestimmung>1200</xplan:zweckbestimmung>",
        "<xplan:zweckbestimmung><xplan:BP_KomplexeZweckbestGruen>"
        "<xplan:allgemein>1000</xplan:allgemein>"
        "</xplan:BP_KomplexeZweckbestGruen></xplan:zweckbestimmung>",
    )
    assert "BP_KomplexeZweckbestGruen" in plan

    green = _by_id(_extract(tmp_path, plan)["BP_GruenFlaeche"])["G1"]

    assert green["allgemein"] == 1000
    assert green["allgemeinWert"] == "Parkanlage"


def test_a_plan_without_a_coordinate_system_is_refused(tmp_path: Path):
    """Geometry that states no `srsName` anywhere cannot be placed on a map:
    the import says so, and writes no layer with raw geometry bytes."""
    import re

    plan = re.sub(r' srsName="[^"]*"', "", XPLAN_51)
    assert "srsName" not in plan

    with pytest.raises(ValueError, match="coordinate system"):
        _extract(tmp_path, plan)


def test_xplan_role_styles():
    from goatlib.tools.style import bundle_role_style

    area = bundle_role_style("xplan", "BP_BaugebietsTeilFlaeche", "polygon")
    rule = area["classify"][0]
    assert rule["field"] == "artDerBaulNutzungWert"
    colors = {v: c["fill"]["color"] for c in rule["classes"] for v in c["values"]}
    assert colors["Mischgebiet"] == "#b48250"
    assert colors["Allg Wohngebiet"] == "#e86f5f"
    limit = bundle_role_style("xplan", "BP_BauGrenze", "line")
    assert limit["symbol"]["line"]["dash"] == "dashed"
    # A class split by geometry keeps its class's look for that geometry.
    split = bundle_role_style("xplan", "BP_StrassenVerkehrsFlaeche:polygon", "polygon")
    road = bundle_role_style("xplan", "BP_StrassenVerkehrsFlaeche", "polygon")
    assert split["symbol"] == road["symbol"]
    from goatlib.bundles.importers.xplan.schema import (
        SUPPORTED_VERSIONS,
    )
    from goatlib.bundles.importers.xplan.schema import (
        classes as version_classes,
    )
    from goatlib.bundles.importers.xplan.styles import XPLAN_CLASS_STYLES

    classes = {c for v in SUPPORTED_VERSIONS for c in version_classes(v)}
    assert set(XPLAN_CLASS_STYLES) <= classes


def test_land_use_falls_back_to_the_general_use(tmp_path: Path):
    """Plans that state only the general use (Wohnbauflaeche, gemischte
    Bauflaeche, ...) are still coloured by it."""
    general = MEMBERS[2].replace(
        "<xplan:besondereArtDerBaulNutzung>1500</xplan:besondereArtDerBaulNutzung>",
        "<xplan:allgArtDerBaulNutzung>1000</xplan:allgArtDerBaulNutzung>",
    )
    source = _write(tmp_path, "t1.gml", XPLAN_51.replace(MEMBERS[2], general))
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = {
        x.role: x for x in XPlanImporter().extract_layers(str(source), str(workdir))
    }
    areas = _by_id(layers["BP_BaugebietsTeilFlaeche"])
    assert areas["A1"]["artDerBaulNutzungWert"] == "Wohn Bauflaeche"
    assert areas["A2"]["artDerBaulNutzungWert"] is None

    from goatlib.tools.style import bundle_role_style

    rule = bundle_role_style("xplan", "BP_BaugebietsTeilFlaeche", "polygon")[
        "classify"
    ][0]
    assert rule["field"] == "artDerBaulNutzungWert"
    colors = {v: c["fill"]["color"] for c in rule["classes"] for v in c["values"]}
    assert colors["Wohn Bauflaeche"] == colors["Allg Wohngebiet"]
    assert colors["Gewerbliche Bauflaeche"] == colors["Gewerbegebiet"]


def test_unstyled_class_is_a_grey_outline():
    """A class without a PlanZV look must not cover the plan in a random colour."""
    from goatlib.tools.style import bundle_role_style

    doc = bundle_role_style("xplan", "BP_Immissionsschutz", "polygon")
    assert doc["symbol"]["fill"] is False
    assert doc["symbol"]["outline"]["color"] == "#8c8c8c"


def test_zoning_label(tmp_path: Path):
    """The label a paper plan writes into each building area, built once."""
    full = MEMBERS[2].replace(
        "<xplan:GRZ>0.6</xplan:GRZ>",
        "<xplan:GFZ>1.7</xplan:GFZ><xplan:GRZ>0.6</xplan:GRZ>"
        "<xplan:Zmin>3</xplan:Zmin><xplan:Zmax>5</xplan:Zmax>"
        "<xplan:allgArtDerBaulNutzung>2000</xplan:allgArtDerBaulNutzung>",
    )
    source = _write(tmp_path, "t1.gml", XPLAN_51.replace(MEMBERS[2], full))
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = {
        x.role: x for x in XPlanImporter().extract_layers(str(source), str(workdir))
    }
    areas = _by_id(layers["BP_BaugebietsTeilFlaeche"])
    assert areas["A1"]["beschriftung"] == "M-MI\nGRZ 0,6  GFZ 1,7\nIII–V  g"
    # Nothing stated, no empty label parts.
    assert areas["A2"]["beschriftung"] is None

    from goatlib.tools.style import bundle_role_style

    label = bundle_role_style("xplan", "BP_BaugebietsTeilFlaeche", "polygon")["symbol"][
        "label"
    ]
    assert label["text"] == "{beschriftung}"


def test_no_namespace_columns(tmp_path: Path):
    """A file that declares xlink on each link gets a `<field>_xlink` column
    per link from GDAL, holding only the namespace address."""
    source = _write(tmp_path, "wfs.gml", XPLAN_51_WFS)
    workdir = tmp_path / "work"
    workdir.mkdir()
    for layer in XPlanImporter().extract_layers(str(source), str(workdir)):
        assert not [c for c in _rows(layer)[0] if c.endswith("_xlink")], layer.role


def test_planzv_colour_names():
    """The PlanZV annex names a colour per item: Dörfliche Wohngebiete are a
    mixed area (Braun mittel), road areas Goldocker."""
    from goatlib.bundles.importers.xplan.styles import LAND_USE_COLORS, ROAD_OCHRE
    from goatlib.tools.style import bundle_role_style

    assert LAND_USE_COLORS["Doerfliches Wohngebiet"] == LAND_USE_COLORS["Dorfgebiet"]
    road = bundle_role_style("xplan", "BP_StrassenVerkehrsFlaeche", "polygon")
    assert road["symbol"]["fill"]["color"] == ROAD_OCHRE
    farm = bundle_role_style("xplan", "BP_LandwirtschaftsFlaeche", "polygon")
    assert farm["symbol"]["fill"]["color"] == "#c5d94a"
    monument = bundle_role_style("xplan", "SO_Denkmalschutzrecht", "polygon")
    assert monument["symbol"]["outline"]["color"] == "#d7191c"
    forest = bundle_role_style("xplan", "BP_WaldFlaeche", "polygon")
    assert forest["symbol"]["fill"]["color"] == "#2e8b7a"
