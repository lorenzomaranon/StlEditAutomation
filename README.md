# Grabador de texto en STL

Graba (hunde) tres textos en `template.stl` —cara **frontal** (inclinada), **izquierda** y **derecha**— y devuelve un STL nuevo listo para imprimir. Sustituye el trabajo manual en Fusion.

## Instalar como programa en Windows (recomendado)

1. Ve a la pestaña **Actions** del repositorio en GitHub → *Build Windows installer* → la última ejecución en verde → descarga el artefacto **GrabadorSTL-Setup** (es un .zip con el instalador dentro).
   Si se ha publicado una versión (etiqueta `v1.0.0`, etc.), también está en **Releases**.
2. Ejecuta `GrabadorSTL-Setup.exe`. Como el instalador no está firmado, Windows puede mostrar *"Windows protegió su PC"*: pulsa **Más información → Ejecutar de todas formas**.
3. Se crea el acceso en el menú Inicio (y en el escritorio si lo marcas). La app se abre en su propia ventana.

En el programa instalado:
- **Descargar STL** abre el diálogo "Guardar como".
- **Cambiar plantilla STL…** (en *Calibración de caras*) carga otro modelo y autodetecta sus caras.
- La calibración, la plantilla y las fuentes que añadas se guardan en `%APPDATA%\GrabadorSTL` (copia ahí tus `.ttf` en la carpeta `fonts`). Se conservan al actualizar o desinstalar.
- Para actualizar, instala el nuevo Setup encima.

### Generar una versión nueva del instalador

Cada push a la rama compila el instalador automáticamente. Para publicar una versión:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Para compilarlo a mano en un PC con Windows: `pip install -r requirements.txt -r requirements-desktop.txt`, `pyinstaller GrabadorSTL.spec` y `iscc installer.iss` (requiere Inno Setup 6). El instalador queda en `Output/`.

## Modo desarrollo

### Instalación (una vez)

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Uso con la web local

```bash
python app.py
```

Se abre `http://localhost:8000`:

1. Escribe el texto de cada cara (deja vacío para no grabar esa cara). Con *auto* activado el resultado se regenera mientras escribes (< 1 s).
2. Ajusta altura de letra, profundidad de grabado, giro, desplazamiento (→ / ↑ en mm), espaciado y fuente si hace falta.
3. **Descargar STL**.

Si el texto se sale de la cara plana aparece un aviso ⚠: reduce la altura o muévelo.

## Calibrar las caras

`faces.json` guarda, para cada cara, el punto donde va el centro del texto, la normal de la cara y los ajustes por defecto. Viene autodetectado para `template.stl`. Para cambiarlo:

- **Ver**: pone la cámara de frente a esa cara.
- **Marcar**: haz clic en el modelo donde quieras centrar el texto de esa cara.
- **Guardar ajustes** (en *Calibración de caras*): guarda posiciones y ajustes en `faces.json` (los textos no se guardan).
- **Autodetectar caras**: vuelve a la propuesta automática (laterales = mayores caras planas ±Y, frontal = mayor cara plana inclinada).

## Uso por línea de comandos

```bash
python engrave.py --front "ABC" --left "Hola" --right "Mundo" --height 5 --depth 0.6 -o salida.stl
```

## Fuentes

Copia cualquier `.ttf`/`.otf` a `fonts/` y aparecerá en el desplegable. Incluidas: DejaVu Sans y DejaVu Sans Bold (licencia libre).

## Cómo funciona

- `engrave.py`: convierte el texto en contornos con *fontTools*, los extruye con *manifold3d*, los coloca sobre la cara (sobresaliendo 0,5 mm hacia fuera y entrando `depth` mm) y los **resta** del modelo. El resultado es un sólido cerrado.
- `app.py`: servidor FastAPI que sirve la web (`static/`, visor three.js incluido en `static/vendor`, funciona sin internet).
- `desktop.py`: arranca el servidor en segundo plano y lo muestra en una ventana nativa (pywebview + Edge WebView2). Es el punto de entrada del `.exe` (`python desktop.py` para probarlo).
- `paths.py`: rutas de recursos y de datos de usuario (carpeta del proyecto en desarrollo, `%APPDATA%\GrabadorSTL` en el programa instalado).
- Empaquetado: `GrabadorSTL.spec` (PyInstaller), `installer.iss` (Inno Setup) y `.github/workflows/build-windows.yml` (compilación en GitHub Actions).
- Para usar otro modelo, sustituye `template.stl` y pulsa *Autodetectar caras* o marca las caras a mano.
