"""geoapi's image installs goatlib without its "full" extra (no boto3), so the
shared layer lock must come from a module that imports nothing heavy."""

import os
import subprocess
import sys


def test_layer_write_lock_imports_without_boto3() -> None:
    code = (
        "import sys; sys.modules['boto3'] = None; sys.modules['botocore'] = None; "
        "import geoapi.services.layer_write_lock"
    )
    env = {**os.environ, "KEYCLOAK_SERVER_URL": "http://keycloak.test"}
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env
    )
    assert result.returncode == 0, result.stderr[-2000:]
