"""Rutas de recursos y datos de usuario.

- En desarrollo (python app.py) todo vive en la carpeta del proyecto.
- En el ejecutable de Windows (PyInstaller) los recursos de solo lectura están
  dentro del paquete y los datos del usuario (calibración, plantilla, fuentes
  añadidas) en %APPDATA%\\GrabadorSTL, para que se conserven entre versiones.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_NAME = "GrabadorSTL"
FROZEN = getattr(sys, "frozen", False)

RESOURCES = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
if FROZEN:
    DATA = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
else:
    DATA = RESOURCES

STATIC = RESOURCES / "static"
BUNDLED_FONTS = RESOURCES / "fonts"
USER_FONTS = DATA / "fonts"
TEMPLATE = DATA / "template.stl"
FACES = DATA / "faces.json"


def ensure_user_data() -> None:
    """Primera ejecución: copia la plantilla y la calibración por defecto."""
    DATA.mkdir(parents=True, exist_ok=True)
    USER_FONTS.mkdir(parents=True, exist_ok=True)
    for name in ("template.stl", "faces.json"):
        dst = DATA / name
        src = RESOURCES / name
        if not dst.exists() and src.exists():
            shutil.copyfile(src, dst)


def font_dirs() -> list[Path]:
    dirs = [USER_FONTS, BUNDLED_FONTS]
    out = []
    for d in dirs:
        if d.exists() and d.resolve() not in [x.resolve() for x in out]:
            out.append(d)
    return out
