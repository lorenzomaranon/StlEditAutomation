# Grabador de texto en STL

Graba (hunde) tres textos en `template.stl` —cara **frontal** (inclinada), **izquierda** y **derecha**— y devuelve un STL nuevo listo para imprimir. Sustituye el trabajo manual en Fusion.

## Instalación (una vez)

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Uso con la web local

```bash
python app.py
```

Se abre `http://localhost:8000`:

1. Escribe el texto de cada cara (deja vacío para no grabar esa cara). Con *auto* activado el resultado se regenera mientras escribes (< 1 s).
2. Ajusta altura de letra, profundidad de grabado, giro, desplazamiento (→ / ↑ en mm), espaciado y fuente si hace falta.
3. **Descargar STL**.

Si el texto se sale de la cara plana aparece un aviso ⚠: reduce la altura o muévelo.

### Calibrar las caras

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
- Para usar otro modelo, sustituye `template.stl` y pulsa *Autodetectar caras* o marca las caras a mano.
