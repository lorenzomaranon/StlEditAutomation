"""Grabado de texto en caras de un STL.

Uso por línea de comandos:
    python engrave.py --front "ABC" --left "Hola" --right "Mundo" -o salida.stl

La posición de cada cara se lee de faces.json (ver README).
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

import manifold3d as mf
import numpy as np
import trimesh
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

import paths

DEFAULT_FONT = "DejaVuSans-Bold.ttf"
FACE_NAMES = ("front", "left", "right")
OVERSHOOT = 0.5  # mm que el cuerpo del texto sobresale fuera de la cara


# --------------------------------------------------------------------------- #
# Texto -> contornos 2D
# --------------------------------------------------------------------------- #
class _FlattenPen(BasePen):
    """Pen de fontTools que aproxima las curvas con segmentos rectos."""

    def __init__(self, glyphset, steps: int = 8):
        super().__init__(glyphset)
        self.steps = steps
        self.contours: list[list[tuple[float, float]]] = []
        self._cur: list[tuple[float, float]] = []

    def _moveTo(self, p):
        self._cur = [p]

    def _lineTo(self, p):
        self._cur.append(p)

    def _curveToOne(self, p1, p2, p3):
        p0 = self._cur[-1]
        for t in np.linspace(0, 1, self.steps + 1)[1:]:
            mt = 1 - t
            self._cur.append(tuple(
                mt**3 * np.array(p0) + 3 * mt**2 * t * np.array(p1)
                + 3 * mt * t**2 * np.array(p2) + t**3 * np.array(p3)))

    def _qCurveToOne(self, p1, p2):
        p0 = self._cur[-1]
        for t in np.linspace(0, 1, self.steps + 1)[1:]:
            mt = 1 - t
            self._cur.append(tuple(
                mt**2 * np.array(p0) + 2 * mt * t * np.array(p1) + t**2 * np.array(p2)))

    def _closePath(self):
        if len(self._cur) >= 3:
            self.contours.append(self._cur)
        self._cur = []

    _endPath = _closePath


_font_cache: dict[str, TTFont] = {}


def list_fonts() -> list[str]:
    return sorted({p.name for d in paths.font_dirs() for p in d.glob("*")
                   if p.suffix.lower() in (".ttf", ".otf")})


def _load_font(name: str) -> TTFont:
    name = Path(name).name
    path = next((d / name for d in paths.font_dirs() if (d / name).exists()), None)
    if path is None:
        raise ValueError(f"Fuente no encontrada: {name}")
    if name not in _font_cache:
        _font_cache[name] = TTFont(str(path))
    return _font_cache[name]


def text_contours(text: str, font_name: str, height: float,
                  spacing: float = 0.0, line_spacing: float = 1.3) -> list[np.ndarray]:
    """Devuelve los contornos (en mm) del texto, centrado en (0, 0).

    `height` es la altura de las mayúsculas en mm. `spacing` añade espacio
    extra entre letras (mm). Admite varias líneas separadas por '\\n'.
    """
    font = _load_font(font_name)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    os2 = font["OS/2"]
    cap = getattr(os2, "sCapHeight", 0) or font["head"].unitsPerEm * 0.7
    scale = height / cap

    contours: list[np.ndarray] = []
    lines = text.split("\n")
    for li, line in enumerate(lines):
        x = 0.0
        y = -li * cap * line_spacing
        line_contours = []
        for ch in line:
            gname = cmap.get(ord(ch)) or ".notdef"
            pen = _FlattenPen(gs)
            gs[gname].draw(pen)
            for c in pen.contours:
                arr = np.array(c, dtype=float)
                arr[:, 0] += x
                arr[:, 1] += y
                line_contours.append(arr)
            x += hmtx[gname][0] + spacing / scale
        # centrar cada línea horizontalmente
        if line_contours:
            width = x - spacing / scale
            for arr in line_contours:
                arr[:, 0] -= width / 2
        contours.extend(line_contours)

    if not contours:
        return []
    allp = np.vstack(contours)
    center = (allp.min(0) + allp.max(0)) / 2
    return [(c - center) * scale for c in contours]


# --------------------------------------------------------------------------- #
# Geometría
# --------------------------------------------------------------------------- #
@dataclass
class FaceSpec:
    point: np.ndarray
    normal: np.ndarray
    up: np.ndarray

    @classmethod
    def from_dict(cls, d: dict) -> "FaceSpec":
        n = np.asarray(d["normal"], float)
        n /= np.linalg.norm(n)
        up = np.asarray(d.get("up", [0, 0, 1]), float)
        up = up - n * up.dot(n)  # proyectar sobre la cara
        if np.linalg.norm(up) < 1e-6:
            up = np.cross(n, [1, 0, 0]) if abs(n[0]) < 0.9 else np.cross(n, [0, 1, 0])
        up /= np.linalg.norm(up)
        return cls(np.asarray(d["point"], float), n, up)

    def frame(self) -> np.ndarray:
        """Matriz 4x4 local->mundo: X = derecha del texto, Y = arriba, Z = normal."""
        x = np.cross(self.up, self.normal)
        m = np.eye(4)
        m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, self.up, self.normal, self.point
        return m


@dataclass
class TextJob:
    text: str
    height: float = 6.0
    depth: float = 0.6
    font: str = DEFAULT_FONT
    spacing: float = 0.0
    offset: tuple[float, float] = (0.0, 0.0)  # desplazamiento (mm) en la cara: derecha, arriba
    rotation: float = 0.0  # grados, giro adicional en el plano de la cara


def _to_manifold(mesh: trimesh.Trimesh) -> mf.Manifold:
    return mf.Manifold(mf.Mesh(vert_properties=np.asarray(mesh.vertices, np.float32),
                               tri_verts=np.asarray(mesh.faces, np.uint32)))


def _to_trimesh(man: mf.Manifold) -> trimesh.Trimesh:
    m = man.to_mesh()
    return trimesh.Trimesh(vertices=np.asarray(m.vert_properties)[:, :3],
                           faces=np.asarray(m.tri_verts), process=False)


def _local_contours(job: TextJob) -> list[np.ndarray]:
    contours = text_contours(job.text, job.font, job.height, job.spacing)
    a = np.radians(job.rotation)
    rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    return [c @ rot.T + np.asarray(job.offset) for c in contours]


def text_solid(face: FaceSpec, job: TextJob) -> mf.Manifold | None:
    contours = _local_contours(job)
    if not contours:
        return None
    cs = mf.CrossSection(contours, mf.FillRule.NonZero)
    # Extruir desde z=-depth hasta z=+OVERSHOOT (z local = normal hacia fuera)
    solid = cs.extrude(job.depth + OVERSHOOT).translate((0, 0, -job.depth))
    return solid.transform(face.frame()[:3, :])


def check_fit(mesh: trimesh.Trimesh, face: FaceSpec, job: TextJob, tol: float = 0.05) -> str | None:
    """Comprueba que todo el contorno del texto cae sobre la cara plana."""
    contours = _local_contours(job)
    if not contours:
        return None
    pts2 = np.vstack([c[:: max(1, len(c) // 12)] for c in contours])
    frame = face.frame()
    # Triángulos coplanares con la cara (misma normal y mismo plano)
    tris = mesh.triangles
    coplanar = (mesh.face_normals @ face.normal > 0.999) & (
        np.abs((tris[:, 0] - face.point) @ face.normal) < tol)
    if not coplanar.any():
        return "el punto de calibración no está sobre una cara plana del modelo"
    # Pasar esos triángulos al sistema 2D de la cara y probar punto-en-triángulo
    t2 = (tris[coplanar] - face.point) @ frame[:3, :2]  # (T, 3, 2)
    a, b, c = t2[:, 0], t2[:, 1], t2[:, 2]

    def cross2(u, v):
        return u[..., 0] * v[..., 1] - u[..., 1] * v[..., 0]

    p = pts2[:, None, :]
    d1 = cross2(b - a, p - a)
    d2 = cross2(c - b, p - b)
    d3 = cross2(a - c, p - c)
    eps = 1e-6
    inside = ((d1 >= -eps) & (d2 >= -eps) & (d3 >= -eps)) | ((d1 <= eps) & (d2 <= eps) & (d3 <= eps))
    bad = ~inside.any(axis=1)
    frac = bad.mean()
    if frac > 0:
        return f"{frac:.0%} del contorno del texto se sale de la cara plana"
    return None


def engrave(mesh: trimesh.Trimesh, faces: dict[str, dict], jobs: dict[str, TextJob]
            ) -> tuple[trimesh.Trimesh, list[str]]:
    warnings: list[str] = []
    cutters = []
    for name, job in jobs.items():
        if not job.text.strip():
            continue
        if name not in faces:
            raise ValueError(f"La cara '{name}' no está calibrada en faces.json")
        face = FaceSpec.from_dict(faces[name])
        w = check_fit(mesh, face, job)
        if w:
            warnings.append(f"{name}: {w}")
        solid = text_solid(face, job)
        if solid is not None:
            cutters.append(solid)
    if not cutters:
        return mesh.copy(), warnings
    base = _to_manifold(mesh)
    if base.status() != mf.Error.NoError:
        raise ValueError(f"El STL de entrada no es un sólido cerrado válido ({base.status()})")
    result = base - mf.Manifold.batch_boolean(cutters, mf.OpType.Add)
    return _to_trimesh(result), warnings


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def load_mesh(path: str | Path) -> trimesh.Trimesh:
    mesh = trimesh.load(str(path), force="mesh")
    mesh.merge_vertices()
    if not mesh.is_watertight:
        trimesh.repair.fill_holes(mesh)
        trimesh.repair.fix_normals(mesh)
    return mesh


def autodetect_faces(mesh: trimesh.Trimesh) -> dict[str, dict]:
    """Propuesta inicial: laterales = mayores caras planas ±Y, frontal = mayor cara inclinada."""
    areas = mesh.facets_area
    order = np.argsort(-areas)

    def centroid(i):
        f = mesh.facets[i]
        w = mesh.area_faces[f]
        return (mesh.triangles_center[f] * w[:, None]).sum(0) / w.sum()

    out: dict[str, dict] = {}
    for i in order:
        n = mesh.facets_normal[i]
        if "left" not in out and n[1] < -0.99:
            out["left"] = {"point": centroid(i).tolist(), "normal": n.tolist(), "up": [0, 0, 1]}
        elif "right" not in out and n[1] > 0.99:
            out["right"] = {"point": centroid(i).tolist(), "normal": n.tolist(), "up": [0, 0, 1]}
        elif "front" not in out and abs(n[1]) < 0.1 and n[2] > 0.1 and n[2] < 0.99:
            out["front"] = {"point": centroid(i).tolist(), "normal": n.tolist(), "up": [0, 0, 1]}
        if len(out) == 3:
            break
    base = detect_base(mesh)
    if base:
        out["base"] = base
    return out


def _boundary_loops(mesh: trimesh.Trimesh, faces) -> int:
    """Número de contornos de una cara plana (2 o más = tiene agujeros)."""
    edges = np.sort(mesh.faces[faces][:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2), axis=1)
    uniq, counts = np.unique(edges, axis=0, return_counts=True)
    border = uniq[counts == 1]
    parent: dict[int, int] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in border:
        parent[find(a)] = find(b)
    return len({find(v) for v in border.reshape(-1)})


def detect_base(mesh: trimesh.Trimesh) -> dict | None:
    """Cara de apoyo para imprimir: la mayor cara plana con agujero que mira hacia abajo
    sin ser horizontal (en template.stl, la cara inclinada con el agujero)."""
    for i in np.argsort(-mesh.facets_area):
        n = mesh.facets_normal[i]
        if -0.99 < n[2] < -0.1 and _boundary_loops(mesh, mesh.facets[i]) >= 2:
            f = mesh.facets[i]
            w = mesh.area_faces[f]
            c = (mesh.triangles_center[f] * w[:, None]).sum(0) / w.sum()
            return {"point": c.tolist(), "normal": n.tolist()}
    return None


def main():
    ap = argparse.ArgumentParser(description="Graba texto en las caras de un STL")
    ap.add_argument("--input", default=str(paths.TEMPLATE))
    ap.add_argument("--faces", default=str(paths.FACES))
    ap.add_argument("--front", default="")
    ap.add_argument("--left", default="")
    ap.add_argument("--right", default="")
    ap.add_argument("--height", type=float, default=6.0, help="altura de letra (mm)")
    ap.add_argument("--depth", type=float, default=0.6, help="profundidad de grabado (mm)")
    ap.add_argument("--font", default=DEFAULT_FONT)
    ap.add_argument("--autodetect", action="store_true", help="regenerar faces.json automáticamente")
    ap.add_argument("-o", "--output", default="salida.stl")
    a = ap.parse_args()

    mesh = load_mesh(a.input)
    if a.autodetect:
        Path(a.faces).write_text(json.dumps(autodetect_faces(mesh), indent=2))
        print(f"faces.json regenerado en {a.faces}")
    faces = json.loads(Path(a.faces).read_text())
    jobs = {n: TextJob(getattr(a, n), a.height, a.depth, a.font) for n in FACE_NAMES}
    result, warnings = engrave(mesh, faces, jobs)
    for w in warnings:
        print("AVISO:", w)
    result.export(a.output)
    print(f"Guardado {a.output}")


if __name__ == "__main__":
    main()
