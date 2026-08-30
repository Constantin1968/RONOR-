import io, sys
PATH = "/etc/caddy/Caddyfile"
with io.open(PATH, "r", encoding="utf-8") as f:
    lines = f.read().split("\n")
if any("order respond first" in l for l in lines):
    print("ABORT: order respond first exista deja."); sys.exit(2)
# corectare comentariu devenit fals
for i, l in enumerate(lines):
    if "respond este evaluat inaintea" in l:
        lines[i] = "    # Ordinea e fortata explicit prin 'order respond first' in blocul global,"
        lines.insert(i + 1, "    # pentru ca in ordinea implicita respond se sorteaza DUPA handle_path.")
        break
# inserare in blocul global, dupa admin off
done = False
for i, l in enumerate(lines):
    if l.strip() == "admin off":
        lines.insert(i + 1, "    order respond first")
        done = True
        break
if not done:
    print("ABORT: nu am gasit 'admin off' in blocul global."); sys.exit(3)
with io.open(PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("OK: order respond first inserat. Linii:", len(lines))
