"""Programa de escritorio: abre la app en su propia ventana (Edge WebView2 en Windows).

Ejecutar en desarrollo:  python desktop.py
En el instalador de Windows este es el punto de entrada de GrabadorSTL.exe.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
from pathlib import Path

import paths


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _log_error(exc: BaseException) -> Path:
    paths.DATA.mkdir(parents=True, exist_ok=True)
    log = paths.DATA / "error.log"
    log.write_text("".join(traceback.format_exception(exc)), encoding="utf-8")
    return log


class Api:
    """Funciones de Python accesibles desde JavaScript como window.pywebview.api.*"""

    def __init__(self):
        self.window = None
        self.last_dir = str(Path.home() / "Documents")

    def save_stl(self, name: str | None = None) -> dict:
        import webview
        import app as server
        data = server.last_result["data"]
        if not data:
            return {"ok": False, "msg": "Primero genera un STL"}
        res = self.window.create_file_dialog(
            webview.SAVE_DIALOG, directory=self.last_dir,
            save_filename=name or server.last_result["name"],
            file_types=("Archivos STL (*.stl)",))
        if not res:
            return {"ok": False, "msg": "Cancelado"}
        path = Path(res if isinstance(res, str) else res[0])
        if path.suffix.lower() != ".stl":
            path = path.with_suffix(".stl")
        path.write_bytes(data)
        self.last_dir = str(path.parent)
        return {"ok": True, "msg": f"Guardado en {path}"}

    def open_data_folder(self) -> None:
        if sys.platform == "win32":
            os.startfile(paths.DATA)  # noqa: S606


def main():
    import uvicorn

    import app as server

    port = _free_port()
    config = uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning",
                            log_config=None)
    srv = uvicorn.Server(config)
    threading.Thread(target=srv.run, daemon=True).start()

    url = f"http://127.0.0.1:{port}/"
    for _ in range(100):  # esperar a que el servidor responda (máx. 10 s)
        try:
            urllib.request.urlopen(url + "api/config", timeout=1)
            break
        except OSError:
            time.sleep(0.1)

    if os.environ.get("GRABADOR_SELFTEST"):  # usado en CI: comprobar sin abrir ventana
        req = urllib.request.Request(url + "api/generate", method="POST",
                                     data=json.dumps({"front": {"text": "OK"}}).encode(),
                                     headers={"Content-Type": "application/json"})
        data = urllib.request.urlopen(req, timeout=60).read()
        assert len(data) > 1000, "STL vacío"
        srv.should_exit = True
        return

    import webview

    api = Api()
    api.window = webview.create_window("Grabador de texto STL", url, js_api=api,
                                       width=1350, height=860, min_size=(900, 600))
    webview.start()
    srv.should_exit = True


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log = _log_error(e)
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, f"Error al iniciar. Detalles en:\n{log}",
                                             "Grabador STL", 0x10)
        except Exception:  # noqa: BLE001
            print(f"Error: detalles en {log}", file=sys.stderr)
        raise
