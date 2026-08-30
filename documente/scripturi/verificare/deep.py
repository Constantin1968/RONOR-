import socket, struct, sys

def redis(host, port):
    s = socket.socket(); s.settimeout(6)
    try:
        s.connect((host, port)); s.sendall(b"*1\r\n$4\r\nPING\r\n")
        return repr(s.recv(120)[:100])
    except Exception as e:
        return "ERR " + type(e).__name__
    finally: s.close()

def pg(host, port):
    """SSLRequest: raspunsul 'S' sau 'N' dovedeste un Postgres real."""
    s = socket.socket(); s.settimeout(6)
    try:
        s.connect((host, port))
        s.sendall(struct.pack("!II", 8, 80877103))
        r = s.recv(1)
        return "raspuns SSLRequest = %r  (S=accepta TLS, N=refuza TLS)" % r
    except Exception as e:
        return "ERR " + type(e).__name__
    finally: s.close()

def http(host, port, path):
    s = socket.socket(); s.settimeout(7)
    try:
        s.connect((host, port))
        req = "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nUser-Agent: audit\r\n\r\n" % (path, host)
        s.sendall(req.encode())
        buf = b""
        while len(buf) < 400:
            try:
                c = s.recv(400)
            except Exception:
                break
            if not c: break
            buf += c
        first = buf.split(b"\r\n")[0].decode("utf-8", "replace")
        body = buf.split(b"\r\n\r\n", 1)[-1][:160].decode("utf-8", "replace").replace("\n", " ")
        return "%s   |   %s" % (first, body)
    except Exception as e:
        return "ERR " + type(e).__name__
    finally: s.close()

print("=== REDIS ===")
for h in ("165.245.248.223", "178.104.118.10"):
    print(" ", h, redis(h, 6379))
print("=== POSTGRES ===")
for h in ("165.245.248.223", "178.104.118.10"):
    print(" ", h, pg(h, 5432))
print("=== QDRANT :6333 /collections ===")
for h in ("165.245.248.223", "178.104.118.10"):
    print(" ", h, http(h, 6333, "/collections"))
print("=== MINIO :9000 /minio/health/live ===")
print("  178.104.118.10", http("178.104.118.10", 9000, "/minio/health/live"))
print("=== WHISPER :8200 / ===")
for h in ("169.58.129.223", "178.104.118.10"):
    print(" ", h, http(h, 8200, "/"))
print("=== CONTABO :80 / ===")
print("  169.58.129.223", http("169.58.129.223", 80, "/"))
print("=== DIGITALOCEAN :80 / ===")
print("  165.245.248.223", http("165.245.248.223", 80, "/"))
