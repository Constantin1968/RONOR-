import socket, sys
targets = [
    ("Contabo Whisper", "169.58.129.223", 8200),
    ("Contabo HTTP", "169.58.129.223", 80),
    ("Contabo SSH", "169.58.129.223", 22),
    ("DigitalOcean Postgres", "165.245.248.223", 5432),
    ("DigitalOcean HTTP", "165.245.248.223", 80),
    ("DigitalOcean HTTPS", "165.245.248.223", 443),
    ("DigitalOcean SSH", "165.245.248.223", 22),
    ("DigitalOcean Redis", "165.245.248.223", 6379),
    ("DigitalOcean Qdrant", "165.245.248.223", 6333),
    ("Hetzner Postgres", "178.104.118.10", 5432),
    ("Hetzner Redis", "178.104.118.10", 6379),
    ("Hetzner Qdrant", "178.104.118.10", 6333),
    ("Hetzner MinIO S3", "178.104.118.10", 9000),
    ("Hetzner Whisper", "178.104.118.10", 8200),
]
for name, host, port in targets:
    s = socket.socket(); s.settimeout(7)
    try:
        s.connect((host, port))
        banner = ""
        try:
            s.settimeout(2.5)
            b = s.recv(64)
            banner = repr(b[:40])
        except Exception:
            banner = "(fara banner)"
        print("DESCHIS   %-26s %s:%s  %s" % (name, host, port, banner))
    except socket.timeout:
        print("filtrat   %-26s %s:%s" % (name, host, port))
    except Exception as e:
        print("inchis    %-26s %s:%s  %s" % (name, host, port, type(e).__name__))
    finally:
        s.close()
