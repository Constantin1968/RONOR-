"""Inside a non-networked candidate container. No messages/model calls/writes."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
from relay_transport import http_client

async def main():
    assert os.geteuid() == 10001
    assert not Path("/var/run/docker.sock").exists()
    assert not Path("/root/.ssh").exists()
    assert not Path("/opt/ronor").exists()
    assert not Path("/run/secrets/relay.json").exists()
    assert not shutil.which("docker") and not shutil.which("ssh")
    for host, port in [("1.1.1.1", 443), ("172.20.0.1", 22), ("127.0.0.1", 8300)]:
        try:
            with socket.create_connection((host, port), timeout=1):
                raise AssertionError("Direct TCP unexpectedly permitted")
        except OSError:
            pass
    checks = {"uid": os.geteuid(), "direct_tcp": "denied", "admin_mounts": "absent"}
    async with http_client(timeout=15) as client:
        for label, url in [
            ("telegram", "https://api.telegram.org/botproxy-managed/getMe"),
            ("memory_health", "http://ronor-r-memory:8101/health"),
            ("cida_health", "http://cida-api:8300/health"),
        ]:
            response = await client.get(url)
            checks[label] = response.status_code
            assert response.status_code == 200, label
            if label == "telegram":
                assert response.json().get("ok") is True
        for label, url in [
            ("docker_api", "http://172.20.0.1:2375/containers/json"),
            ("cida_admin", "http://cida-api:8300/api-keys"),
            ("cida_search_no_key", "http://cida-api:8300/search?q=fixture&mode=lexical"),
            ("arbitrary_egress", "https://example.com/"),
        ]:
            response = await client.get(url)
            checks[label] = response.status_code
            assert response.status_code == 403, label
    print(json.dumps(checks))

asyncio.run(main())
