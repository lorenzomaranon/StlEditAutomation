# -*- mode: python ; coding: utf-8 -*-
# Empaquetado con PyInstaller:  pyinstaller GrabadorSTL.spec
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

datas = [
    ("static", "static"),
    ("fonts", "fonts"),
    ("template.stl", "."),
    ("faces.json", "."),
    ("assets/icon.ico", "assets"),
]
binaries = []
hiddenimports = collect_submodules("uvicorn") + ["app", "engrave", "paths", "slicer"]

for pkg in ("webview", "manifold3d", "fontTools"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("trimesh")

a = Analysis(
    ["desktop.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "PyQt5", "PyQt6", "PySide2", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="GrabadorSTL",
    icon="assets/icon.ico",
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="GrabadorSTL")
