import socket, struct
# Citim doar provocarea de autentificare. Nicio parola trimisa, nicio data citita.
IP = "165.245.248.223"

def startup(user, db):
    s = socket.create_connection((IP, 5432), 8); s.settimeout(8)
    s.sendall(struct.pack("!ii", 8, 80877103)); s.recv(1)
    body = b"user\x00" + user.encode() + b"\x00database\x00" + db.encode() + b"\x00\x00"
    s.sendall(struct.pack("!ii", 8 + len(body), 196608) + body)
    d = s.recv(200); s.close(); return d

M = {0: "AuthenticationOk — FARA PAROLA, ACCES LIBER", 3: "cere parola in clar",
     5: "cere MD5", 10: "cere SASL/SCRAM", 7: "GSSAPI"}
for u, db in [("ronor", "ronor"), ("postgres", "postgres")]:
    try:
        d = startup(u, db); tag = d[:1]
        if tag == b'R':
            code = struct.unpack("!i", d[5:9])[0]
            print(f"  user={u} db={db}: {M.get(code, code)}")
        elif tag == b'E':
            print(f"  user={u} db={db}: eroare -> {d[5:].replace(chr(0).encode(), b' ').decode('utf8','replace')[:140]}")
        else:
            print(f"  user={u} db={db}: tag={tag}")
    except Exception as e:
        print(f"  user={u} db={db}: {type(e).__name__}")
