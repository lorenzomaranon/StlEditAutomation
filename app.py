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

paths.ensure_user_data()
TEMPLATE = paths.TEMPLATE
FACES = paths.FACES

app = FastAPI(title="STL Text Engraver")
_mesh = eg.load_mesh(TEMPLATE)
last_result: dict = {"data": None, "name": "resultado.stl"}  # último STL generado


def _read_faces() -> dict:
    if FACES.exists():
        return json.loads(FACES.read_text(encoding="utf-8"))
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
    _write_faces(new)
    return new


@app.post("/api/generate")
def generate(req: GenerateRequest):
    jobs = {}
    for name in eg.FACE_NAMES:
        j: Job = getattr(req, name)
        jobs[name] = eg.TextJob(j.text, j.height, j.depth, j.font, j.spacing,
                                tuple(j.offset[:2]), j.rotation)
    try:
        result, warnings = eg.engrave(_mesh, req.faces or _read_faces(), jobs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    buf = io.BytesIO()
    result.export(buf, file_type="stl")
    parts = [re.sub(r"[^\w-]+", "_", getattr(req, n).text).strip("_") for n in eg.FACE_NAMES]
    fname = "_".join(p for p in parts if p) or "template"
    last_result.update(data=buf.getvalue(), name=fname + ".stl")
    return Response(buf.getvalue(), media_type="model/stl", headers={
        "X-Warnings": quote(json.dumps(warnings, ensure_ascii=False)),
        "X-Filename": quote(fname + ".stl"),
        "Access-Control-Expose-Headers": "X-Warnings, X-Filename",
    })


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
