"""All application HTTP is carried over a private Unix socket; no TCP fallback."""
import base64
import json
import os
import httpx


class RelayTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.inner = httpx.AsyncHTTPTransport(
            uds=os.getenv("RONOR_EGRESS_SOCKET", "/run/egress/egress.sock"))

    async def handle_async_request(self, request):
        body = await request.aread()
        payload = {
            "method": request.method, "url": str(request.url),
            "headers": dict(request.headers),
            "body": base64.b64encode(body).decode(),
        }
        envelope = httpx.Request("POST", "http://relay/forward",
                                 json=payload, extensions=request.extensions)
        response = await self.inner.handle_async_request(envelope)
        try:
            await response.aread()
            data = response.json()
            return httpx.Response(int(data["status"]), headers=data["headers"],
                                  content=base64.b64decode(data["body"], validate=True),
                                  request=request)
        finally:
            await response.aclose()

    async def aclose(self):
        await self.inner.aclose()


def http_client(**kwargs):
    return httpx.AsyncClient(transport=RelayTransport(), trust_env=False, **kwargs)
