"""Construye la versión web estática (sin servidor) en _site/ para GitHub Pages.

    python build_web.py            # genera _site/
    python -m http.server -d _site 8080   # probarla en local
"""
import json
import re
import shutil
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "_site"

if OUT.exists():
    shutil.rmtree(OUT)
shutil.copytree(ROOT / "static", OUT)


def stl_to_binary(src: Path, dst: Path) -> None:
    """Copia el STL; si es ASCII lo convierte a binario (unas 5 veces más pequeño)."""
    data = src.read_bytes()
    if len(data) >= 84 and 84 + 50 * struct.unpack_from("<I", data, 80)[0] == len(data):
        dst.write_bytes(data)
        return
    v = [float(x) for x in re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data) for x in x]
    n = len(v) // 9
    out = bytearray(80) + struct.pack("<I", n)
    for i in range(n):
        out += struct.pack("<12fH", 0, 0, 0, *v[i * 9:i * 9 + 9], 0)
    dst.write_bytes(out)


stl_to_binary(ROOT / "template.stl", OUT / "template.stl")
shutil.copy(ROOT / "faces.json", OUT / "faces.json")
(OUT / "fonts").mkdir()
fonts = sorted(p.name for p in (ROOT / "fonts").iterdir() if p.suffix.lower() in (".ttf", ".otf"))
for name in fonts:
    shutil.copy(ROOT / "fonts" / name, OUT / "fonts" / name)
(OUT / "fonts" / "index.json").write_text(json.dumps(fonts))

index = OUT / "index.html"
html = index.read_text(encoding="utf-8")
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="engine" content="local">', 1)
index.write_text(html, encoding="utf-8")
(OUT / ".nojekyll").write_text("")
print(f"Versión web generada en {OUT} ({len(fonts)} fuentes)")
