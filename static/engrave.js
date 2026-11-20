// Motor de grabado en JavaScript (port de engrave.py) para la versión web.
// Funciona igual en el navegador y en Node (para pruebas).
//   wasm: módulo de manifold-3d ya inicializado (setup())
//   font: fuente de opentype.js

export const OVERSHOOT = 0.5; // mm que el texto sobresale fuera de la cara

// ------------------------------------------------------------ vectores
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / norm(a));

// ------------------------------------------------------------ STL
/** Lee un STL (binario o ASCII) y devuelve Float32Array con 9 floats por triángulo. */
export function parseSTL(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buffer.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let j = 0; j < 9; j++) out[i * 9 + j] = dv.getFloat32(o + j * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(buffer);
  const nums = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  if (!nums.length || nums.length % 9) throw new Error("STL inválido o vacío");
  return new Float32Array(nums);
}

/** Fusiona vértices idénticos: {verts: Float32Array, tris: Uint32Array}. */
export function indexMesh(triangles) {
  const map = new Map();
  const verts = [];
  const tris = new Uint32Array(triangles.length / 3);
  for (let i = 0; i < triangles.length; i += 3) {
    const key = `${triangles[i]},${triangles[i + 1]},${triangles[i + 2]}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      map.set(key, idx);
      verts.push(triangles[i], triangles[i + 1], triangles[i + 2]);
    }
    tris[i / 3] = idx;
  }
  return { verts: new Float32Array(verts), tris };
}

export function toSTL(verts, tris) {
  const n = tris.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const v = [0, 1, 2].map((k) => {
      const j = tris[i * 3 + k] * 3;
      return [verts[j], verts[j + 1], verts[j + 2]];
    });
    let nn = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    const l = norm(nn);
    nn = l > 0 ? scale(nn, 1 / l) : [0, 0, 0];
    let o = 84 + i * 50;
    for (const x of [nn, ...v]) for (const c of x) { dv.setFloat32(o, c, true); o += 4; }
  }
  return buf;
}

// ------------------------------------------------------------ modelo
export class Model {
  constructor(wasm, stlBuffer) {
    this.wasm = wasm;
    const { verts, tris } = indexMesh(parseSTL(stlBuffer));
    this.verts = verts;
    this.tris = tris;
    const ntri = tris.length / 3;
    this.normals = new Float32Array(ntri * 3);
    this.areas = new Float32Array(ntri);
    for (let t = 0; t < ntri; t++) {
      const [a, b, c] = this.tri(t);
      const n = cross(sub(b, a), sub(c, a));
      const l = norm(n);
      this.areas[t] = l / 2;
      if (l > 0) this.normals.set(scale(n, 1 / l), t * 3);
    }
    this._manifold = null;
  }

  tri(t) {
    const v = this.verts, T = this.tris;
    return [0, 1, 2].map((k) => { const j = T[t * 3 + k] * 3; return [v[j], v[j + 1], v[j + 2]]; });
  }

  normal(t) { return [this.normals[t * 3], this.normals[t * 3 + 1], this.normals[t * 3 + 2]]; }

  manifold() {
    if (!this._manifold) {
      const { Mesh, Manifold } = this.wasm;
      const mesh = new Mesh({ numProp: 3, vertProperties: this.verts, triVerts: this.tris });
      mesh.merge();
      try {
        this._manifold = new Manifold(mesh);
      } catch (e) {
        throw new Error("El STL no es un sólido cerrado válido");
      }
    }
    return this._manifold;
  }

  /** Igual que autodetect_faces en Python: mayores caras planas ±Y y la mayor inclinada. */
  autodetectFaces() {
    const ntri = this.tris.length / 3;
    // caras planas: regiones de triángulos vecinos con la misma normal (como trimesh.facets)
    const parent = new Int32Array(ntri).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const edges = new Map();
    for (let t = 0; t < ntri; t++) {
      if (this.areas[t] <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const a = this.tris[t * 3 + k], b = this.tris[t * 3 + ((k + 1) % 3)];
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        const other = edges.get(key);
        if (other === undefined) edges.set(key, t);
        else if (dot(this.normal(t), this.normal(other)) > 0.99999) parent[find(t)] = find(other);
      }
    }
    const comps = new Map();
    for (let t = 0; t < ntri; t++) {
      if (this.areas[t] <= 0) continue;
      const r = find(t);
      (comps.get(r) || comps.set(r, []).get(r)).push(t);
    }
    const facets = [];
    for (const tris of comps.values()) {
      if (tris.length < 2) continue;
      let area = 0, c = [0, 0, 0], nn = [0, 0, 0];
      for (const t of tris) {
        const [a, b, cc] = this.tri(t);
        const w = this.areas[t];
        area += w;
        for (let i = 0; i < 3; i++) { c[i] += w * (a[i] + b[i] + cc[i]) / 3; nn[i] += w * this.normals[t * 3 + i]; }
      }
      facets.push({ area, normal: unit(nn), point: scale(c, 1 / area), tris });
    }
    facets.sort((a, b) => b.area - a.area);
    const out = {};
    for (const f of facets) {
      const n = f.normal;
      const entry = { point: f.point, normal: n, up: [0, 0, 1] };
      if (!out.left && n[1] < -0.99) out.left = entry;
      else if (!out.right && n[1] > 0.99) out.right = entry;
      else if (!out.front && Math.abs(n[1]) < 0.1 && n[2] > 0.1 && n[2] < 0.99) out.front = entry;
      if (out.left && out.right && out.front) break;
    }
    // base de impresión: mayor cara plana con agujero que mira hacia abajo sin ser horizontal
    for (const f of facets) {
      if (f.normal[2] > -0.99 && f.normal[2] < -0.1 && this.boundaryLoops(f.tris) >= 2) {
        out.base = { point: f.point, normal: f.normal };
        break;
      }
    }
    return out;
  }

  boundaryLoops(tris) {
    const count = new Map();
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const a = this.tris[t * 3 + k], b = this.tris[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
    const parent = new Map();
    const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const verts = new Set();
    for (const [key, c] of count) if (c === 1) {
      const [a, b] = key.split("_").map(Number);
      parent.set(find(a), find(b)); verts.add(a); verts.add(b);
    }
    return new Set([...verts].map(find)).size;
  }
}

// ------------------------------------------------------------ texto
function flattenPath(commands, steps = 8) {
  const contours = [];
  let cur = [];
  const close = () => { if (cur.length >= 3) contours.push(cur); cur = []; };
  for (const c of commands) {
    if (c.type === "M") { close(); cur = [[c.x, c.y]]; }
    else if (c.type === "L") cur.push([c.x, c.y]);
    else if (c.type === "Q") {
      const [x0, y0] = cur[cur.length - 1];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, mt = 1 - t;
        cur.push([mt * mt * x0 + 2 * mt * t * c.x1 + t * t * c.x, mt * mt * y0 + 2 * mt * t * c.y1 + t * t * c.y]);
      }
    } else if (c.type === "C") {
      const [x0, y0] = cur[cur.length - 1];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, mt = 1 - t;
        const a = mt ** 3, b = 3 * mt * mt * t, d = 3 * mt * t * t, e = t ** 3;
        cur.push([a * x0 + b * c.x1 + d * c.x2 + e * c.x, a * y0 + b * c.y1 + d * c.y2 + e * c.y]);
      }
    } else if (c.type === "Z") close();
  }
  close();
  // quitar el último punto si repite el primero
  for (const ct of contours) {
    const a = ct[0], b = ct[ct.length - 1];
    if (ct.length > 3 && a[0] === b[0] && a[1] === b[1]) ct.pop();
  }
  return contours;
}

/** Contornos del texto en mm, centrados en (0,0). `height` = altura de mayúsculas. */
export function textContours(font, text, height, spacing = 0, lineSpacing = 1.3) {
  const cap = font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7;
  const s = height / cap;
  const contours = [];
  text.split("\n").forEach((line, li) => {
    let x = 0;
    const y = -li * cap * lineSpacing;
    const lineC = [];
    for (const ch of Array.from(line)) {
      const g = font.charToGlyph(ch);
      for (const ct of flattenPath(g.path.commands)) lineC.push(ct.map(([px, py]) => [px + x, py + y]));
      x += g.advanceWidth + spacing / s;
    }
    if (lineC.length) {
      const w = x - spacing / s;
      for (const ct of lineC) for (const p of ct) p[0] -= w / 2;
    }
    contours.push(...lineC);
  });
  if (!contours.length) return [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const ct of contours) for (const [px, py] of ct) {
    minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
  }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  return contours.map((ct) => ct.map(([px, py]) => [(px - cx) * s, (py - cy) * s]));
}

function localContours(font, job) {
  const cts = textContours(font, job.text, job.height, job.spacing || 0);
  const a = ((job.rotation || 0) * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  const [ox, oy] = job.offset || [0, 0];
  return cts.map((ct) => ct.map(([x, y]) => [co * x - si * y + ox, si * x + co * y + oy]));
}

// ------------------------------------------------------------ caras
export function faceFrame(f) {
  const n = unit(f.normal);
  let up = f.up || [0, 0, 1];
  up = sub(up, scale(n, dot(up, n)));
  if (norm(up) < 1e-6) up = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  up = unit(up);
  const x = cross(up, n);
  const p = f.point;
  return { n, up, x, p, mat: [x[0], x[1], x[2], 0, up[0], up[1], up[2], 0, n[0], n[1], n[2], 0, p[0], p[1], p[2], 1] };
}

export function checkFit(model, fr, contours, tol = 0.05) {
  if (!contours.length) return null;
  const pts = [];
  for (const ct of contours) { const step = Math.max(1, Math.floor(ct.length / 12)); for (let i = 0; i < ct.length; i += step) pts.push(ct[i]); }
  const ntri = model.tris.length / 3;
  const tri2 = [];
  for (let t = 0; t < ntri; t++) {
    if (dot(model.normal(t), fr.n) <= 0.999) continue;
    const tr = model.tri(t);
    if (Math.abs(dot(sub(tr[0], fr.p), fr.n)) >= tol) continue;
    tri2.push(tr.map((v) => { const d = sub(v, fr.p); return [dot(d, fr.x), dot(d, fr.up)]; }));
  }
  if (!tri2.length) return "el punto de calibración no está sobre una cara plana del modelo";
  const c2 = (u, v) => u[0] * v[1] - u[1] * v[0];
  const eps = 1e-6;
  let bad = 0;
  for (const p of pts) {
    let inside = false;
    for (const [a, b, c] of tri2) {
      const d1 = c2([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]);
      const d2 = c2([c[0] - b[0], c[1] - b[1]], [p[0] - b[0], p[1] - b[1]]);
      const d3 = c2([a[0] - c[0], a[1] - c[1]], [p[0] - c[0], p[1] - c[1]]);
      if ((d1 >= -eps && d2 >= -eps && d3 >= -eps) || (d1 <= eps && d2 <= eps && d3 <= eps)) { inside = true; break; }
    }
    if (!inside) bad++;
  }
  return bad ? `${Math.round((100 * bad) / pts.length)}% del contorno del texto se sale de la cara plana` : null;
}

/**
 * Graba los textos. jobs = {front: {text, height, depth, font, spacing, offset, rotation}, ...}
 * fonts = {nombre: fuente opentype}. Devuelve {stl: ArrayBuffer, warnings: [], volume}.
 */
export function engrave(model, faces, jobs, fonts) {
  const { CrossSection, Manifold } = model.wasm;
  const warnings = [];
  const cutters = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!job.text || !job.text.trim()) continue;
    if (!faces[name]) throw new Error(`La cara '${name}' no está calibrada`);
    const font = fonts[job.font];
    if (!font) throw new Error(`Fuente no encontrada: ${job.font}`);
    const fr = faceFrame(faces[name]);
    const cts = localContours(font, job);
    if (!cts.length) continue;
    const w = checkFit(model, fr, cts);
    if (w) warnings.push(`${name}: ${w}`);
    const cs = new CrossSection(cts, "NonZero");
    const ex = cs.extrude(job.depth + OVERSHOOT);
    const tr = ex.translate([0, 0, -job.depth]);
    cutters.push(tr.transform(fr.mat));
    cs.delete(); ex.delete(); tr.delete();
  }
  const base = model.manifold();
  if (!cutters.length) {
    return { stl: toSTL(model.verts, model.tris), warnings, volume: base.volume() };
  }
  const tool = Manifold.union(cutters);
  const result = base.subtract(tool);
  const mesh = result.getMesh();
  const verts = mesh.numProp === 3 ? mesh.vertProperties
    : mesh.vertProperties.filter((_, i) => i % mesh.numProp < 3);
  const out = { stl: toSTL(verts, mesh.triVerts), warnings, volume: result.volume() };
  for (const c of cutters) c.delete();
  tool.delete(); result.delete();
  return out;
}
