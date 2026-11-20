"""Laminado con la CLI de OrcaSlicer e inserción de cambios de color (M600).

- Perfiles: se leen los perfiles de usuario de OrcaSlicer y se "aplanan" siguiendo la
  cadena `inherits` (perfiles de usuario y de sistema), para pasarle a la CLI un JSON
  completo que no dependa de cómo resuelve la herencia cada versión de Orca.
- Orientación: el modelo se gira para apoyarlo en la cara "base" (normal -> -Z).
- Cambios de color: se insertan en el G-code ya laminado, al principio de la capa elegida.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

PRESET_TYPES = ("machine", "process", "filament")
_DROP_KEYS = {"inherits", "include", "compatible_printers", "compatible_printers_condition",
              "compatible_prints", "compatible_prints_condition", "instantiation", "setting_id",
              "base_id", "is_custom_defined", "version", "renamed_from"}


# --------------------------------------------------------------------------- #
# Orientación y capas
# --------------------------------------------------------------------------- #
def base_rotation(normal) -> np.ndarray:
    """Matriz 3x3 que gira `normal` hasta -Z (la cara base queda apoyada en la cama)."""
    n = np.asarray(normal, float)
    n = n / np.linalg.norm(n)
    t = np.array([0.0, 0.0, -1.0])
    c = float(n @ t)
    if c > 1 - 1e-9:
        return np.eye(3)
    if c < -1 + 1e-9:  # normal = +Z: media vuelta sobre X
        return np.diag([1.0, -1.0, -1.0])
    v = np.cross(n, t)
    s = np.linalg.norm(v)
    k = v / s
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    ang = math.atan2(s, c)
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * (K @ K)


def layer_count(height: float, layer_h: float, first_h: float) -> int:
    if height <= first_h:
        return 1
    return 1 + math.ceil(round((height - first_h) / layer_h, 6))


def layer_bottom_z(layer: int, layer_h: float, first_h: float) -> float:
    """Z (mm sobre la cama) donde empieza la capa `layer` (1 = primera capa)."""
    return 0.0 if layer <= 1 else first_h + (layer - 2) * layer_h


def fraction_layer(n_layers: int, fraction: float) -> int:
    """Capa donde empieza el color nuevo para que ocupe desde `fraction` del total.
    Redondea hacia arriba: con 151 capas y 1/2 -> capa 76 (75 + 76)."""
    return min(n_layers, max(2, math.floor(n_layers * fraction + 1e-9) + 1))


# --------------------------------------------------------------------------- #
# Perfiles de OrcaSlicer
# --------------------------------------------------------------------------- #
def orca_data_dir() -> Path | None:
    cands = []
    if sys.platform == "win32":
        cands.append(Path(os.environ.get("APPDATA", "")) / "OrcaSlicer")
    elif sys.platform == "darwin":
        cands.append(Path.home() / "Library/Application Support/OrcaSlicer")
    else:
        cands.append(Path.home() / ".config/OrcaSlicer")
    return next((c for c in cands if c.is_dir()), None)


def find_orca() -> str | None:
    cands = []
    if sys.platform == "win32":
        for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                cands += [Path(base) / "OrcaSlicer" / "orca-slicer.exe",
                          Path(base) / "Programs" / "OrcaSlicer" / "orca-slicer.exe"]
    elif sys.platform == "darwin":
        cands.append(Path("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"))
    else:
        cands += [Path("/usr/bin/orca-slicer"), Path.home() / "Applications/OrcaSlicer.AppImage"]
    return next((str(c) for c in cands if c.is_file()), None)


def _read_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def list_presets(data_dir: Path | None = None) -> dict[str, list[dict]]:
    """Perfiles de usuario: {"machine": [{"name","path"}], "process": [...], "filament": [...]}"""
    data_dir = data_dir or orca_data_dir()
    out: dict[str, list[dict]] = {t: [] for t in PRESET_TYPES}
    if not data_dir:
        return out
    for t in PRESET_TYPES:
        for p in sorted((data_dir / "user").glob(f"*/{t}/*.json")):
            d = _read_json(p)
            if d:
                out[t].append({"name": d.get("name", p.stem), "path": str(p)})
    return out


@dataclass
class PresetIndex:
    """Busca perfiles por nombre en las carpetas de usuario y de sistema de Orca."""
    roots: list[Path]
    _cache: dict[tuple[str, str], Path | None] = field(default_factory=dict)
    _scanned: dict[str, dict[str, Path]] = field(default_factory=dict)

    @classmethod
    def default(cls, orca_exe: str | None, data_dir: Path | None = None) -> "PresetIndex":
        roots = []
        data_dir = data_dir or orca_data_dir()
        if data_dir:
            roots += [data_dir / "user", data_dir / "system"]
        if orca_exe:
            exe = Path(orca_exe)
            for r in (exe.parent / "resources" / "profiles", exe.parent.parent / "Resources" / "profiles",
                      exe.parent / "usr" / "share" / "OrcaSlicer" / "profiles"):
                roots.append(r)
        return cls([r for r in roots if r.is_dir()])

    def find(self, name: str, ptype: str) -> Path | None:
        key = (name, ptype)
        if key in self._cache:
            return self._cache[key]
        hit = None
        for root in self.roots:  # rápido: el archivo suele llamarse como el perfil
            for p in root.glob(f"**/{ptype}/**/{glob_escape(name)}.json"):
                if _read_json(p).get("name", p.stem) == name:
                    hit = p
                    break
            if hit:
                break
        if not hit:
            if ptype not in self._scanned:
                idx: dict[str, Path] = {}
                for root in self.roots:
                    for p in root.glob(f"**/{ptype}/**/*.json"):
                        n = _read_json(p).get("name")
                        if n and n not in idx:
                            idx[n] = p
                self._scanned[ptype] = idx
            hit = self._scanned[ptype].get(name)
        self._cache[key] = hit
        return hit


def glob_escape(s: str) -> str:
    return re.sub(r"([\[\]\*\?])", r"[\1]", s)


def resolve_preset(path: str | Path, ptype: str, index: PresetIndex, _depth: int = 0) -> dict:
    """Devuelve el perfil completo (herencia resuelta)."""
    if _depth > 20:
        raise ValueError("Cadena 'inherits' demasiado larga (¿ciclo?)")
    data = _read_json(Path(path))
    if not data:
        raise ValueError(f"No se pudo leer el perfil {path}")
    merged: dict = {}
    parents = []
    inc = data.get("include")
    if inc:
        parents += inc if isinstance(inc, list) else [inc]
    if data.get("inherits"):
        parents.append(data["inherits"])
    for name in parents:
        pp = index.find(name, ptype)
        if pp is None:
            raise ValueError(f"No encuentro el perfil padre '{name}' ({ptype}). "
                             "Comprueba la ruta de OrcaSlicer.")
        merged.update(resolve_preset(pp, ptype, index, _depth + 1))
    merged.update(data)
    return merged


def flatten_preset(path: str | Path, ptype: str, index: PresetIndex) -> dict:
    d = resolve_preset(path, ptype, index)
    out = {k: v for k, v in d.items() if k not in _DROP_KEYS}
    out.update({"type": ptype, "from": "User", "inherits": "", "name": d.get("name", Path(path).stem)})
    return out


def _num(v, default: float) -> float:
    if isinstance(v, list):
        v = v[0] if v else default
    try:
        return float(str(v).rstrip("%"))
    except (TypeError, ValueError):
        return default


def layer_heights(process: dict) -> tuple[float, float]:
    h = _num(process.get("layer_height"), 0.2)
    h1 = _num(process.get("initial_layer_print_height", process.get("first_layer_height")), h)
    return h, h1


# --------------------------------------------------------------------------- #
# Cambios de color en el G-code
# --------------------------------------------------------------------------- #
_LAYER_RE = re.compile(r"^;\s*(CHANGE_LAYER|LAYER_CHANGE)\s*$")
_Z_RE = re.compile(r"^;\s*(?:Z:|Z_HEIGHT:)\s*([-\d.]+)")
_HEIGHT_RE = re.compile(r"^;\s*(?:HEIGHT:|LAYER_HEIGHT:)\s*([-\d.]+)")
_FEATURE_RE = re.compile(r"^;\s*(FEATURE:|TYPE:)")


@dataclass
class Layer:
    start: int          # índice de la línea del marcador de capa
    z: float            # Z superior de la capa
    height: float | None = None

    @property
    def bottom(self) -> float:
        return self.z - (self.height if self.height is not None else 0.0)


def parse_layers(lines: list[str]) -> list[Layer]:
    layers: list[Layer] = []
    for i, line in enumerate(lines):
        if _LAYER_RE.match(line):
            z, h = None, None
            for j in range(i + 1, min(i + 6, len(lines))):
                m = _Z_RE.match(lines[j])
                if m and z is None:
                    z = float(m.group(1))
                m = _HEIGHT_RE.match(lines[j])
                if m and h is None:
                    h = float(m.group(1))
            if z is not None:
                if layers and abs(z - layers[-1].z) < 1e-6:
                    continue  # marcador repetido para la misma capa
                layers.append(Layer(i, z, h))
    for k, L in enumerate(layers):  # completar alturas que falten
        if L.height is None:
            L.height = L.z - (layers[k - 1].z if k else 0.0)
    return layers


def _insert_index(lines: list[str], layers: list[Layer], k: int) -> int:
    """Primera línea de la capa k antes de imprimir nada (antes del primer ;FEATURE/;TYPE)."""
    end = layers[k + 1].start if k + 1 < len(layers) else len(lines)
    for i in range(layers[k].start + 1, end):
        if _FEATURE_RE.match(lines[i]):
            return i
    # sin marcador de tipo: justo después de la cabecera de la capa
    i = layers[k].start + 1
    while i < end and (_Z_RE.match(lines[i]) or _HEIGHT_RE.match(lines[i])):
        i += 1
    return i


@dataclass
class ColorChange:
    layer: int | None = None      # capa (1 = primera) donde empieza el color nuevo
    color: str = "#ffffff"
    fraction: float | None = None  # si viene de "dividir en partes iguales"
    z: float | None = None         # Z de inicio prevista (para recolocar si cambian las capas)


def insert_color_changes(gcode: str, changes: list[ColorChange], predicted_layers: int | None = None
                         ) -> tuple[str, list[dict], list[str]]:
    """Inserta M600 y devuelve (gcode, [{layer, z, color}], avisos)."""
    lines = gcode.splitlines(keepends=True)
    stripped = [ln.rstrip("\r\n") for ln in lines]
    layers = parse_layers(stripped)
    warnings: list[str] = []
    if not layers:
        raise ValueError("No encuentro las capas en el G-code (marcadores ; CHANGE_LAYER / ;Z:)")
    n = len(layers)
    mismatch = predicted_layers is not None and predicted_layers != n
    if mismatch:
        warnings.append(f"OrcaSlicer ha generado {n} capas (la previsión era {predicted_layers}); "
                        "los cambios se han recolocado por altura.")
    targets: list[tuple[int, str]] = []
    for ch in changes:
        if ch.fraction is not None:
            k = fraction_layer(n, ch.fraction)
        elif mismatch and ch.z is not None:
            k = next((i + 1 for i, L in enumerate(layers) if L.bottom >= ch.z - 1e-4), n)
        else:
            k = ch.layer or 1
        if k < 2 or k > n:
            warnings.append(f"Cambio en capa {k} fuera de rango (2–{n}); se ignora.")
            continue
        targets.append((k, ch.color))
    targets = sorted(dict(targets).items())  # una sola vez por capa
    inserted = []
    for k, color in sorted(targets, reverse=True):  # de abajo arriba para no mover índices
        idx = _insert_index(stripped, layers, k - 1)
        block = [f"; Grabador STL: cambio de color en capa {k} -> {color}\n", "M600\n"]
        lines[idx:idx] = block
        stripped[idx:idx] = [b.rstrip("\n") for b in block]
        inserted.append({"layer": k, "z": round(layers[k - 1].bottom, 3), "color": color})
    return "".join(lines), sorted(inserted, key=lambda d: d["layer"]), warnings


def gcode_stats(gcode: str) -> dict:
    out: dict = {}
    m = re.search(r";\s*estimated printing time[^=]*=\s*(.+)", gcode)
    if m:
        out["time"] = m.group(1).strip()
    m = re.search(r";\s*total filament used \[g\]\s*=\s*([\d.]+)", gcode) or \
        re.search(r";\s*filament used \[g\]\s*=\s*([\d.]+)", gcode)
    if m:
        out["grams"] = float(m.group(1))
    return out


# --------------------------------------------------------------------------- #
# Laminado
# --------------------------------------------------------------------------- #
def orient_for_print(mesh, base_normal):
    """Copia del mesh girada sobre la base y apoyada en Z=0."""
    m = mesh.copy()
    if base_normal is not None:
        R = np.eye(4)
        R[:3, :3] = base_rotation(base_normal)
        m.apply_transform(R)
    m.apply_translation([0, 0, -m.bounds[0][2]])
    return m


def run_orca(orca_exe: str, stl_path: Path, machine: Path, process: Path, filament: Path,
             out_dir: Path, timeout: int = 600) -> Path:
    cmd = [orca_exe, "--load-settings", f"{machine};{process}", "--load-filaments", str(filament),
           "--arrange", "1", "--slice", "0", "--outputdir", str(out_dir), str(stl_path)]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=flags,
                           encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise RuntimeError(f"No encuentro OrcaSlicer en {orca_exe}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("OrcaSlicer ha tardado demasiado en laminar")
    gcodes = sorted(out_dir.rglob("*.gcode"))
    if not gcodes:
        for z in out_dir.rglob("*.3mf"):
            with zipfile.ZipFile(z) as zf:
                names = [n for n in zf.namelist() if n.endswith(".gcode")]
                if names:
                    p = out_dir / "plate.gcode"
                    p.write_bytes(zf.read(sorted(names)[0]))
                    gcodes = [p]
                    break
    if not gcodes:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-15:]
        raise RuntimeError(f"OrcaSlicer no generó G-code (código {r.returncode}).\n" + "\n".join(tail))
    return gcodes[0]


def slice_mesh(mesh, base_normal, cfg: dict, changes: list[ColorChange], predicted_layers: int | None):
    """Lamina el mesh (ya grabado) con los perfiles de cfg e inserta los M600."""
    orca = cfg.get("orca") or find_orca()
    if not orca:
        raise RuntimeError("No encuentro OrcaSlicer. Indica la ruta de orca-slicer.exe en Laminado.")
    for t in PRESET_TYPES:
        if not cfg.get(t):
            raise RuntimeError(f"Elige el perfil de {dict(machine='impresora', process='proceso', filament='filamento')[t]}.")
    index = PresetIndex.default(orca)
    with tempfile.TemporaryDirectory(prefix="grabadorstl_") as tmp:
        tmp = Path(tmp)
        files = {}
        for t in PRESET_TYPES:
            files[t] = tmp / f"{t}.json"
            files[t].write_text(json.dumps(flatten_preset(cfg[t], t, index), ensure_ascii=False), encoding="utf-8")
        stl = tmp / "modelo.stl"
        orient_for_print(mesh, base_normal).export(stl)
        out = tmp / "out"
        out.mkdir()
        gpath = run_orca(orca, stl, files["machine"], files["process"], files["filament"], out)
        gcode = gpath.read_text(encoding="utf-8", errors="replace")
    gcode, inserted, warnings = insert_color_changes(gcode, changes, predicted_layers)
    n = len(parse_layers(gcode.splitlines()))
    return gcode, {"layers": n, "changes": inserted, "warnings": warnings, **gcode_stats(gcode)}
