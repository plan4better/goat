# Routing

Package for flexible and performant multi-modal routing and accessibility analysis. Currently supports one-to-one, one-to-many, many-to-many, and many-to-all routing, along with reverse traversal.

### Modes
- Walking
- Cycling
- Driving
- Public Transport

## Architecture

<div align="center">
	<img src="routing_architecture.png" alt="Routing architecture diagram" />
</div>

## Tests

`tests/` holds the router's own tests, run through its Python bindings. `test_snapping.py` builds its own small networks. `test_catchment.py` and `test_munich_catchment_integration.py` route from Marienplatz on Munich's street network, read where the tools read it: `STREET_NETWORK_EDGES_BASE_PATH` and `STREET_NETWORK_NODES_BASE_PATH`, else `street_network/edges` and `street_network/nodes` under `DATA_DIR` (default `/app/data`), where goatlib's `sync_base_data` installs it. Without it they skip, except in CI, where they fail. CI runs them in the `routing (pytest)` job of `.github/workflows/test.yml`, on Munich's H3 res-3 cell 8077.

To run them, from the repository root: build the wheel and install it into a venv of its own (the workspace venv is often synced without routing, as CI does), install Munich's cell with goatlib from the workspace venv, and point `DATA_DIR` at the directory it went to.

```sh
uv build --wheel packages/cpp/routing --out-dir /tmp/routing-wheel
uv venv /tmp/routing-venv
uv pip install --python /tmp/routing-venv/bin/python pytest pytest-asyncio pyarrow /tmp/routing-wheel/*.whl
uv run --no-sync python -c "from goatlib.tasks.sync_base_data import SyncBaseDataParams, sync; print(sync(SyncBaseDataParams(datasets=['street_network'], h3_3=[8077], data_dir='/tmp/routing-data')))"
DATA_DIR=/tmp/routing-data /tmp/routing-venv/bin/python -m pytest packages/cpp/routing/tests
```
