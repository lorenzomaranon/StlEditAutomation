"""Servidor web local: python app.py  ->  http://localhost:8000"""
from __future__ import annotations

import io
import json
import re
import threading
import webbrowser
from pathlib import Path
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engrave as eg
import paths
import slicer as sl

paths.ensure_user_data()
TEMPLATE = paths.TEMPLATE
FACES = paths.FACES

app = FastAPI(title="STL Text Engraver")
_mesh = eg.load_mesh(TEMPLATE)
last_result: dict = {"data": None, "name": "resultado.stl"}  # último STL generado
last_gcode: dict = {"data": None, "name": "resultado.gcode"}  # último G-code laminado


def _read_faces() -> dict:
    if FACES.exists():
        faces = json.loads(FACES.read_text(encoding="utf-8"))
        if "base" not in faces:  # instalaciones anteriores: añadir la base detectada
            base = eg.detect_base(_mesh)
            if base:
                faces["base"] = base
                _write_faces(faces)
        return faces
    faces = eg.autodetect_faces(_mesh)
    _write_faces(faces)
    return faces


def _write_faces(faces: dict) -> None:
    def rnd(v):
        if isinstance(v, float):
            return round(v, 4)
        if isinstance(v, list):
            return [rnd(x) for x in v]
        if isinstance(v, dict):
            return {k: rnd(x) for k, x in v.items()}
        return v
    FACES.write_text(json.dumps(rnd(faces), indent=2, ensure_ascii=False), encoding="utf-8")


class Job(BaseModel):
    text: str = ""
    height: float = 6.0
    depth: float = 0.6
    font: str = eg.DEFAULT_FONT
    spacing: float = 0.0
    offset: list[float] = [0.0, 0.0]
    rotation: float = 0.0


class GenerateRequest(BaseModel):
    front: Job = Job()
    left: Job = Job()
    right: Job = Job()
    faces: dict | None = None  # calibración actual de la interfaz (si no, la guardada)


@app.get("/api/template")
def get_template():
    return FileResponse(TEMPLATE, media_type="model/stl")


@app.post("/api/template")
async def upload_template(request: Request):
    """Sustituye la plantilla por el STL enviado en el cuerpo y autodetecta las caras."""
    global _mesh
    data = await request.body()
    if len(data) < 84:
        raise HTTPException(400, "Archivo STL vacío o inválido")
    tmp = TEMPLATE.with_suffix(".tmp.stl")
    tmp.write_bytes(data)
    try:
        mesh = eg.load_mesh(tmp)
        if len(mesh.faces) == 0:
            raise ValueError("sin triángulos")
    except Exception as e:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"No se pudo leer el STL: {e}")
    tmp.replace(TEMPLATE)
    _mesh = mesh
    warn = None if mesh.is_watertight else "La malla no es un sólido cerrado; el grabado puede fallar."
    return {"faces": autodetect(), "warning": warn}


@app.get("/api/config")
def get_config():
    return {"faces": _read_faces(), "fonts": eg.list_fonts()}


@app.put("/api/faces")
def put_faces(faces: dict):
    for name in eg.FACE_NAMES:
        if name in faces:
            f = faces[name]
            if not all(k in f for k in ("point", "normal")):
                raise HTTPException(400, f"Faltan point/normal en {name}")
    _write_faces(faces)
    return {"ok": True}


@app.post("/api/autodetect")
def autodetect():
    old = _read_faces()
    new = eg.autodetect_faces(_mesh)
    for name, f in new.items():  # conservar ajustes de texto guardados
        keep = {k: v for k, v in old.get(name, {}).items() if k not in ("point", "normal", "up")}
        f.update(keep)
    if "colors" in old:
        new["colors"] = old["colors"]
    _write_faces(new)
    return new


def _engrave(req: GenerateRequest):
    jobs = {}
    for name in eg.FACE_NAMES:
        j: Job = getattr(req, name)
        jobs[name] = eg.TextJob(j.text, j.height, j.depth, j.font, j.spacing,
                                tuple(j.offset[:2]), j.rotation)
    try:
        result, warnings = eg.engrave(_mesh, req.faces or _read_faces(), jobs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    parts = [re.sub(r"[^\w-]+", "_", getattr(req, n).text).strip("_") for n in eg.FACE_NAMES]
    fname = "_".join(p for p in parts if p) or "template"
    return result, warnings, fname


@app.post("/api/generate")
def generate(req: GenerateRequest):
    result, warnings, fname = _engrave(req)
    buf = io.BytesIO()
    result.export(buf, file_type="stl")
    last_result.update(data=buf.getvalue(), name=fname + ".stl")
    return Response(buf.getvalue(), media_type="model/stl", headers={
        "X-Warnings": quote(json.dumps(warnings, ensure_ascii=False)),
        "X-Filename": quote(fname + ".stl"),
        "Access-Control-Expose-Headers": "X-Warnings, X-Filename",
    })


# --------------------------------------------------------------------------- #
# Laminado con OrcaSlicer y cambios de color
# --------------------------------------------------------------------------- #
def _slicer_cfg() -> dict:
    cfg = {}
    if paths.SLICER_CFG.exists():
        try:
            cfg = json.loads(paths.SLICER_CFG.read_text(encoding="utf-8"))
        except ValueError:
            cfg = {}
    if not cfg.get("orca"):
        cfg["orca"] = sl.find_orca() or ""
    return cfg


def _heights(cfg: dict) -> dict | None:
    if not cfg.get("process"):
        return None
    try:
        proc = sl.flatten_preset(cfg["process"], "process", sl.PresetIndex.default(cfg.get("orca") or None))
    except (ValueError, OSError) as e:
        return {"error": str(e)}
    h, h1 = sl.layer_heights(proc)
    return {"layer_height": h, "first_layer": h1}


@app.get("/api/capabilities")
def capabilities():
    return {"slice": True}


@app.get("/api/slicer")
def get_slicer():
    cfg = _slicer_cfg()
    return {"config": cfg, "presets": sl.list_presets(), "heights": _heights(cfg)}


@app.put("/api/slicer")
def put_slicer(cfg: dict):
    clean = {k: str(cfg.get(k) or "") for k in ("orca", *sl.PRESET_TYPES)}
    paths.SLICER_CFG.write_text(json.dumps(clean, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "heights": _heights(clean)}


class SliceRequest(GenerateRequest):
    colors: dict = {}
    predicted_layers: int | None = None


@app.post("/api/slice")
def slice_endpoint(req: SliceRequest):
    result, warnings, fname = _engrave(req)
    faces = req.faces or _read_faces()
    base = (faces.get("base") or {}).get("normal")
    if not base:
        warnings.append("No hay base de impresión marcada: se lamina en la orientación del STL.")
    changes = [sl.ColorChange(layer=c.get("layer"), color=c.get("color", "#ffffff"),
                              fraction=c.get("fraction"), z=c.get("z"))
               for c in (req.colors or {}).get("changes", [])]
    try:
        gcode, info = sl.slice_mesh(result, base, _slicer_cfg(), changes, req.predicted_layers)
    except (RuntimeError, ValueError) as e:
        raise HTTPException(400, str(e))
    last_gcode.update(data=gcode.encode("utf-8"), name=fname + ".gcode")
    info["warnings"] = warnings + info["warnings"]
    info["name"] = fname + ".gcode"
    return info


@app.get("/api/last_gcode")
def get_last_gcode():
    if not last_gcode["data"]:
        raise HTTPException(404, "Todavía no se ha laminado nada")
    return Response(last_gcode["data"], media_type="text/x-gcode", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(last_gcode['name'])}"})


app.mount("/", StaticFiles(directory=paths.STATIC, html=True), name="static")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    if not a.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{a.port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=a.port)
