import time

from goatlib.style.ids import assign_ids, fresh_id


def test_assign_ids_fills_missing_ids_uniquely() -> None:
    doc = {
        "version": "1.0.0",
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
        "version": "1.0.0",
        "kind": "vector",
        "classify": [
            {"id": "type", "field": "status", "method": "categories"},
            {"field": "type", "method": "categories"},
        ],
    }
    assert [c["id"] for c in assign_ids(doc)["classify"]] == ["type", "k1"]


def test_raster_classes_get_ids() -> None:
    doc = {
        "version": "1.0.0",
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


class _CountingSet(set):
    """A set that counts its membership checks."""

    checks = 0

    def __contains__(self, item: object) -> bool:
        type(self).checks += 1
        return super().__contains__(item)


def test_new_ids_take_the_first_free_number_and_keep_existing_ones() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "classify": [
            {
                "id": "k1",
                "field": "a",
                "method": "categories",
                "classes": [
                    {"id": "c2", "values": ["x"]},
                    {"values": ["y"]},
                    {"id": "c1", "values": ["z"]},
                    {"values": ["w"]},
                    {"id": "c5", "values": ["v"]},
                    {"values": ["u"]},
                ],
            },
            {"field": "c4", "method": "categories", "classes": [{"values": ["t"]}]},
        ],
    }
    out = assign_ids(doc)
    assert [c["id"] for c in out["classify"][0]["classes"]] == [
        "c2",
        "c3",
        "c1",
        "c4",
        "c5",
        "c6",
    ]
    # The field name is taken by then, so the classification counts on from k1.
    assert out["classify"][1]["id"] == "k2"
    assert out["classify"][1]["classes"][0]["id"] == "c7"
    assert assign_ids(out) == out


def test_reserved_ids_are_skipped() -> None:
    doc = {"version": "1.0.0", "kind": "vector", "rules": [{}, {}, {}]}
    out = assign_ids(doc, reserved={"r1", "r3"})
    assert [r["id"] for r in out["rules"]] == ["r2", "r4", "r5"]


def test_fresh_ids_with_a_counter_check_each_number_once() -> None:
    taken = _CountingSet({"c1", "c3"})
    counters: dict[str, int] = {}
    _CountingSet.checks = 0
    ids = [fresh_id("c", taken, counters) for _ in range(20_000)]
    assert ids[:3] == ["c2", "c4", "c5"]
    assert len(set(ids)) == 20_000
    # One check per number given out or skipped, not one per number below it.
    assert _CountingSet.checks == 20_000 + 2


def test_twenty_thousand_items_without_ids_get_ids_quickly() -> None:
    doc = {
        "version": "1.0.0",
        "kind": "vector",
        "classify": [
            {
                "field": "c",
                "method": "categories",
                "classes": [{"values": [f"v{i}"]} for i in range(20_000)],
            }
        ],
        "rules": [{} for _ in range(5_000)],
    }
    t = time.perf_counter()
    out = assign_ids(doc)
    # A bound for work that grows with the square of the input (minutes), not for the machine:
    # CI runners are several times slower than a laptop and share their cores.
    assert time.perf_counter() - t < 10
    classes = out["classify"][0]["classes"]
    assert classes[0]["id"] == "c1" and classes[-1]["id"] == "c20000"
    assert out["rules"][-1]["id"] == "r5000"
