from goatlib.tasks.traffic_rollup import (
    decide_over_budget,
    drain_egress,
    parse_meter_key,
)


def test_parse_meter_key():
    assert parse_meter_key("meter:egress:org1:lyr9:tiles") == ("org1", "lyr9", "tiles")
    assert parse_meter_key("meter:egress:org1:lyr9:features") == (
        "org1",
        "lyr9",
        "features",
    )


def test_decide_over_budget():
    assert decide_over_budget(100, 100) is True
    assert decide_over_budget(99, 100) is False
    assert decide_over_budget(10_000, None) is False  # unlimited never over


class _FakePipeline:
    def __init__(self, redis):
        self._redis = redis
        self._queue: list = []

    def hgetall(self, key):
        self._queue.append(("hgetall", key))

    def hincrby(self, key, field, amount):
        self._queue.append(("hincrby", key, field, amount))

    def execute(self):
        results = []
        for cmd in self._queue:
            if cmd[0] == "hgetall":
                results.append(self._redis.hgetall(cmd[1]))
            elif cmd[0] == "hincrby":
                _, key, field, amount = cmd
                current = int(self._redis.h.get(key, {}).get(field, 0))
                new_val = current + amount
                if key not in self._redis.h:
                    self._redis.h[key] = {}
                self._redis.h[key][field] = str(new_val)
                results.append(new_val)
        return results


class _FakeRedis:
    def __init__(self, hashes):
        self.h = {k: dict(v) for k, v in hashes.items()}

    def scan_iter(self, match):
        prefix = match.replace("*", "")
        return [k for k in self.h if k.startswith(prefix)]

    def hgetall(self, key):
        return self.h.get(key, {})

    def delete(self, key):
        self.h.pop(key, None)

    def pipeline(self):
        return _FakePipeline(self)


def test_drain_egress_reads_and_deletes():
    key_with_bytes = "meter:egress:orgA:lyr1:tiles"
    key_zero_bytes = "meter:egress:orgA:lyr2:features"
    r = _FakeRedis(
        {
            key_with_bytes: {
                "bytes": "1073741824",
                "count": "42",
                "anon_count": "30",
                "owner": "ownA",
            },
            key_zero_bytes: {
                "bytes": "0",
                "count": "3",
                "owner": "ownA",
            },  # 0 bytes -> deleted immediately
        }
    )
    out = drain_egress(r)
    assert len(out) == 1
    row = out[0]
    assert row == {
        "key": key_with_bytes,
        "org": "orgA",
        "owner": "ownA",
        "layer": "lyr1",
        "service": "tiles",
        "bytes": 1073741824,
        "count": 42,
        "anon_count": 30,
    }
    # zero-byte hash is deleted immediately; >0-byte hash is kept for caller to delete
    assert key_zero_bytes not in r.h
    assert key_with_bytes in r.h
