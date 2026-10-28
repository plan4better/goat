from goatlib.style.ids import assign_ids


def test_assign_ids_fills_missing_ids_uniquely() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {
                "field": "type",
                "method": "categories",
                "classes": [{"values": ["a"]}, {"id": "c1", "values": ["b"]}],
            }
        ],
        "rules": [
            {"visible": False, "when": {"op": "isNull", "args": [{"property": "name"}]}}
        ],
        "popup": {
            "blocks": [{"type": "divider"}, {"id": "b1", "type": "text", "html": "x"}]
        },
    }
    out = assign_ids(doc)
    assert out["classify"][0]["id"] == "type"
    assert [c["id"] for c in out["classify"][0]["classes"]] == ["c2", "c1"]
    assert out["rules"][0]["id"] == "r1"
    assert [b["id"] for b in out["popup"]["blocks"]] == ["b2", "b1"]
    assert "id" not in doc["rules"][0]


def test_a_taken_field_name_falls_back_to_a_counter() -> None:
    doc = {
        "version": 1,
        "kind": "vector",
        "classify": [
            {"id": "type", "field": "status", "method": "categories"},
            {"field": "type", "method": "categories"},
        ],
    }
    assert [c["id"] for c in assign_ids(doc)["classify"]] == ["type", "k1"]


def test_raster_classes_get_ids() -> None:
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {
            "type": "continuous",
            "classify": {"method": "quantile", "classes": [{"to": 1}, {"from": 1}]},
        },
    }
    assert [c["id"] for c in assign_ids(doc)["render"]["classify"]["classes"]] == [
        "c1",
        "c2",
    ]
