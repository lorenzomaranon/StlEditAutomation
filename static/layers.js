// Orientación de impresión y capas (mismas fórmulas que slicer.py).

/** Matriz 3x3 (filas) que gira `normal` hasta -Z. */
export function baseRotation(normal) {
  const l = Math.hypot(...normal);
  const n = normal.map((x) => x / l);
  const c = -n[2]; // n · (0,0,-1)
  if (c > 1 - 1e-9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (c < -1 + 1e-9) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const v = [-n[1], n[0], 0]; // n × (0,0,-1)
  const s = Math.hypot(...v);
  const k = v.map((x) => x / s);
  const K = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]];
  const ang = Math.atan2(s, c), sa = Math.sin(ang), ca = 1 - Math.cos(ang);
  const R = [];
  for (let i = 0; i < 3; i++) {
    R.push([]);
    for (let j = 0; j < 3; j++) {
      let kk = 0;
      for (let m = 0; m < 3; m++) kk += K[i][m] * K[m][j];
      R[i].push((i === j ? 1 : 0) + sa * K[i][j] + ca * kk);
    }
  }
  return R;
}

/** positions: Float32Array xyz…  ->  {R, zmin, height} de la pieza apoyada en la base. */
export function printFrame(positions, baseNormal) {
  const R = baseNormal ? baseRotation(baseNormal) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const r = R[2];
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const z = r[0] * positions[i] + r[1] * positions[i + 1] + r[2] * positions[i + 2];
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  return { R, zmin, height: zmax - zmin };
}

export function layerCount(height, h, h1) {
  if (height <= h1) return 1;
  return 1 + Math.ceil(Math.round(((height - h1) / h) * 1e6) / 1e6);
}

/** Z (mm sobre la cama) donde empieza la capa `layer` (1 = primera). */
export const layerBottomZ = (layer, h, h1) => (layer <= 1 ? 0 : h1 + (layer - 2) * h);

/** Capa donde empieza el color nuevo para la fracción f; redondea hacia arriba (151 -> 76). */
export const fractionLayer = (n, f) => Math.min(n, Math.max(2, Math.floor(n * f + 1e-9) + 1));
