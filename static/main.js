import * as THREE from "three";
import { STLLoader } from "./vendor/STLLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { api } from "./api.js";
import { printFrame, layerCount, layerBottomZ, fractionLayer } from "./layers.js";

const FACES = [
  { key: "front", label: "Frontal", color: "#e4572e" },
  { key: "left", label: "Izquierda", color: "#17a398" },
  { key: "right", label: "Derecha", color: "#7b4fd6" },
];
const DEFAULTS = { height: 6, depth: 0.6, font: "DejaVuSans-Bold.ttf", rotation: 0, spacing: 0, offset: [0, 0] };

let config = { faces: {}, fonts: [] };
let picking = null;
let lastBlob = null, lastName = "resultado.stl";

// ------------------------------------------------------------------ visor 3D
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#eef0f3");
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const material = new THREE.MeshStandardMaterial({ color: 0xd8dce3, roughness: 0.6, metalness: 0.05 });
// Bandas de color por altura de impresión (Z tras apoyar la pieza en su base)
const MAX_CHANGES = 8;
const bandUniforms = {
  uRz: { value: new THREE.Vector3(0, 0, 1) },
  uZmin: { value: 0 },
  uBase: { value: new THREE.Color(0xd8dce3) },
  uCount: { value: 0 },
  uCuts: { value: new Array(MAX_CHANGES).fill(1e9) },
  uCols: { value: Array.from({ length: MAX_CHANGES }, () => new THREE.Color()) },
};
material.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, bandUniforms);
  sh.vertexShader = sh.vertexShader
    .replace("#include <common>", "#include <common>\nuniform vec3 uRz;\nuniform float uZmin;\nvarying float vPrintZ;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPrintZ = dot(uRz, position) - uZmin;");
  sh.fragmentShader = sh.fragmentShader
    .replace("#include <common>", `#include <common>
uniform vec3 uBase; uniform int uCount; uniform float uCuts[${MAX_CHANGES}]; uniform vec3 uCols[${MAX_CHANGES}];
varying float vPrintZ;`)
    .replace("vec4 diffuseColor = vec4( diffuse, opacity );", `vec3 bandCol = uBase;
for (int i = 0; i < ${MAX_CHANGES}; i++) { if (i >= uCount) break; if (vPrintZ >= uCuts[i] - 1e-4) bandCol = uCols[i]; }
vec4 diffuseColor = vec4( bandCol, opacity );`);
};
let model = null;
// world: todo lo que está en coordenadas del STL. En "vista de impresión" se gira sobre su base.
const world = new THREE.Group();
world.matrixAutoUpdate = false;
scene.add(world);
const markers = new THREE.Group();
world.add(markers);
// printSpace: coordenadas de impresión (Z = altura sobre la cama) dentro de world
const printSpace = new THREE.Group();
printSpace.matrixAutoUpdate = false;
world.add(printSpace);
let pf = null; // {R, zmin, height}
let printView = false;

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

function render() {
  requestAnimationFrame(render);
  controls.update();
  sun.position.copy(camera.position);
  renderer.render(scene, camera);
}

function showGeometry(buffer, fit = false) {
  const geom = new STLLoader().parse(buffer);
  geom.computeVertexNormals(); // no fiarse de las normales del archivo (pueden venir a 0)
  if (model) { world.remove(model); model.geometry.dispose(); }
  model = new THREE.Mesh(geom, material);
  world.add(model);
  geom.computeBoundingSphere();
  if (fit) fitCamera();
  updatePrintFrame();
}

function fitCamera() {
  if (!model) return;
  world.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  controls.target.copy(center);
  camera.up.set(0, 0, 1);
  camera.position.copy(center).add(new THREE.Vector3(1.6, -2.2, 1.4).normalize().multiplyScalar(radius * 3.2));
  camera.near = radius / 50; camera.far = radius * 50;
  camera.updateProjectionMatrix();
}

/** Recalcula la orientación de impresión (base) y las bandas de color. */
function updatePrintFrame() {
  if (!model) return;
  pf = printFrame(model.geometry.attributes.position.array, config.faces.base?.normal);
  const [r0, r1, r2] = pf.R;
  const m = new THREE.Matrix4().set(r0[0], r0[1], r0[2], 0, r1[0], r1[1], r1[2], 0,
                                    r2[0], r2[1], r2[2], -pf.zmin, 0, 0, 0, 1);
  printSpace.matrix.copy(m).invert();
  world.matrix.copy(printView ? m : new THREE.Matrix4());
  world.updateMatrixWorld(true);
  bandUniforms.uRz.value.set(...r2);
  bandUniforms.uZmin.value = pf.zmin;
  refreshColors();
}

function setPrintView(on) {
  if (on === printView) return;
  printView = on;
  document.getElementById("printView").checked = on;
  updatePrintFrame();
  fitCamera();
}

function drawMarkers() {
  markers.clear();
  const size = model ? model.geometry.boundingSphere.radius : 30;
  for (const f of FACES) {
    const c = config.faces[f.key];
    if (!c) continue;
    const p = new THREE.Vector3(...c.point), n = new THREE.Vector3(...c.normal).normalize();
    markers.add(new THREE.ArrowHelper(n, p, size * 0.35, f.color, size * 0.08, size * 0.05));
  }
  const b = config.faces.base;
  if (b) {
    const p = new THREE.Vector3(...b.point), n = new THREE.Vector3(...b.normal).normalize();
    markers.add(new THREE.ArrowHelper(n, p, size * 0.35, 0x6b7280, size * 0.08, size * 0.05));
  }
}

function lookAt(key) {
  const c = config.faces[key];
  if (!c || !model) return;
  setPrintView(false);
  const p = new THREE.Vector3(...c.point), n = new THREE.Vector3(...c.normal).normalize();
  const r = model.geometry.boundingSphere.radius;
  controls.target.copy(p);
  camera.position.copy(p).addScaledVector(n, r * 2.2);
  // mantener "arriba" de la cámara alineado con el arriba del texto
  const up = new THREE.Vector3(...(c.up || [0, 0, 1]));
  up.addScaledVector(n, -up.dot(n));
  if (up.lengthSq() > 1e-6) camera.up.copy(up.normalize()); else camera.up.set(0, 0, 1);
  camera.lookAt(p);
  controls.update();
  camera.up.set(0, 0, 1);
}
window.__lookAt = lookAt;

// ------------------------------------------------------------------ calibración por clic
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!picking || !model || !downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // fue un arrastre
  const r = canvas.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObject(model)[0];
  if (!hit) return;
  if (picking === "base") {
    config.faces.base = { point: hit.point.toArray(), normal: hit.face.normal.toArray() };
    setPicking(null);
    drawMarkers();
    updatePrintFrame();
    renderColors();
    setStatus(`Base de impresión marcada. Pulsa "Guardar ajustes" para recordarla.`);
    return;
  }
  const c = (config.faces[picking] ||= { ...DEFAULTS });
  c.point = hit.point.toArray();
  c.normal = hit.face.normal.toArray();
  c.up = c.up || [0, 0, 1];
  c.offset = [0, 0];
  readForm();
  setPicking(null);
  drawMarkers();
  setStatus(`Cara marcada. Pulsa "Guardar ajustes" para recordarla.`);
  scheduleAuto();
});

function setPicking(key) {
  picking = key;
  document.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("active", b.dataset.pick === key));
  const hint = document.getElementById("hint");
  hint.style.display = key ? "block" : "none";
  if (key) {
    setPrintView(false);
    canvas.scrollIntoView({ block: "nearest" });
    hint.textContent = key === "base"
      ? "Haz clic en la cara sobre la que se apoya la pieza al imprimir"
      : `Haz clic en la cara ${FACES.find((f) => f.key === key).label.toLowerCase()} (centro del texto)`;
    showTemplate();
  }
}

// ------------------------------------------------------------------ formulario
function buildForm() {
  const box = document.getElementById("faces");
  box.innerHTML = "";
  const fontOpts = config.fonts.map((f) => `<option>${f}</option>`).join("");
  for (const f of FACES) {
    const c = { ...DEFAULTS, ...(config.faces[f.key] || {}) };
    const div = document.createElement("div");
    div.className = "face";
    div.style.setProperty("--c", f.color);
    div.innerHTML = `
      <h2>${f.label} <span><button class="small" data-look="${f.key}">Ver</button>
        <button class="small" data-pick="${f.key}" style="--c:${f.color}">Marcar</button></span></h2>
      <textarea data-k="text" rows="1" placeholder="Texto ${f.label.toLowerCase()}">${c.text || ""}</textarea>
      <details class="opts"${matchMedia("(max-width: 800px)").matches ? "" : " open"}>
      <summary>Ajustes (${c.height} mm, prof. ${c.depth} mm)</summary>
      <div class="grid">
        <label>Altura (mm)<input data-k="height" type="number" step="0.5" min="0.5" value="${c.height}"></label>
        <label>Profund. (mm)<input data-k="depth" type="number" step="0.1" min="0.1" value="${c.depth}"></label>
        <label>Giro (°)<input data-k="rotation" type="number" step="90" value="${c.rotation}"></label>
        <label>Mover → (mm)<input data-k="ox" type="number" step="0.5" value="${c.offset[0]}"></label>
        <label>Mover ↑ (mm)<input data-k="oy" type="number" step="0.5" value="${c.offset[1]}"></label>
        <label>Espaciado<input data-k="spacing" type="number" step="0.1" value="${c.spacing}"></label>
      </div>
      <label style="margin-top:6px">Fuente<select data-k="font">${fontOpts}</select></label>
      </details>`;
    div.dataset.face = f.key;
    div.querySelector("select").value = config.fonts.includes(c.font) ? c.font : config.fonts[0];
    box.appendChild(div);
  }
  box.querySelectorAll("[data-pick]").forEach((b) =>
    b.addEventListener("click", () => setPicking(picking === b.dataset.pick ? null : b.dataset.pick)));
  box.querySelectorAll("[data-look]").forEach((b) => b.addEventListener("click", () => lookAt(b.dataset.look)));
  box.querySelectorAll("textarea, input, select").forEach((el) =>
    el.addEventListener("input", () => { readForm(); scheduleAuto(); }));
}

function readForm() {
  for (const div of document.querySelectorAll(".face")) {
    const c = (config.faces[div.dataset.face] ||= { ...DEFAULTS });
    const v = (k) => div.querySelector(`[data-k="${k}"]`).value;
    c.text = v("text");
    c.height = +v("height"); c.depth = +v("depth"); c.rotation = +v("rotation");
    c.spacing = +v("spacing"); c.font = v("font");
    c.offset = [+v("ox"), +v("oy")];
    const sum = div.querySelector(".opts > summary");
    if (sum) sum.textContent = `Ajustes (${c.height} mm, prof. ${c.depth} mm)`;
  }
}

function jobs() {
  const out = {};
  for (const f of FACES) {
    const c = { ...DEFAULTS, ...(config.faces[f.key] || {}) };
    out[f.key] = { text: c.text || "", height: c.height, depth: c.depth, font: c.font,
                   spacing: c.spacing, offset: c.offset, rotation: c.rotation };
  }
  return out;
}

/** Caras con su calibración y ajustes actuales (sin los textos). */
function currentFaces() {
  readForm();
  const faces = structuredClone(config.faces);
  for (const k in faces) delete faces[k].text;
  return faces;
}

function setStatus(msg, cls = "") {
  const s = document.getElementById("status");
  s.textContent = msg; s.className = cls;
}

// ------------------------------------------------------------------ colores / cambios de filamento
const COLOR_DEFAULTS = { initial: "#e8e8e8", layer_height: 0.2, first_layer: 0.2, changes: [] };
const PALETTE = ["#e4572e", "#2563eb", "#17a398", "#f2c14e", "#7b4fd6", "#111827", "#ffffff", "#9ca3af"];
let selectedChange = null;
const planes = new THREE.Group();
printSpace.add(planes);
const bed = new THREE.GridHelper(256, 16, 0x9ca3af, 0xd1d5db);
bed.rotation.x = Math.PI / 2;
bed.visible = false;
printSpace.add(bed);
const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function colorsCfg() {
  const c = (config.faces.colors ||= structuredClone(COLOR_DEFAULTS));
  c.changes ||= [];
  return c;
}

function layerInfo() {
  const c = colorsCfg();
  const h = +c.layer_height > 0 ? +c.layer_height : 0.2;
  const h1 = +c.first_layer > 0 ? +c.first_layer : h;
  return { h, h1, n: pf ? layerCount(pf.height, h, h1) : 0 };
}

/** Cambios ordenados por capa, con la capa recalculada (las fracciones siguen al nº de capas). */
function sortedChanges() {
  const { h, h1, n } = layerInfo();
  for (const ch of colorsCfg().changes) {
    if (ch.fraction != null) ch.layer = fractionLayer(n, ch.fraction);
    ch.layer = Math.max(2, Math.min(n || 2, Math.round(ch.layer || 2)));
    ch.z = +layerBottomZ(ch.layer, h, h1).toFixed(4);
  }
  return [...colorsCfg().changes].sort((a, b) => a.layer - b.layer);
}

const FRACTION_NAMES = { 0.5: "mitad", [1 / 3]: "1/3", [2 / 3]: "2/3", 0.25: "1/4", 0.75: "3/4", 0.4: "2/5", 0.6: "3/5" };

// Banderas: colores de abajo arriba (las franjas verticales se imprimen horizontales,
// con la franja izquierda abajo).
const FLAGS = {
  es: { name: "España", initial: "#AA151B",
        changes: [{ fraction: 1 / 4, color: "#F1BF00" }, { fraction: 3 / 4, color: "#AA151B" }] },
  pt: { name: "Portugal", initial: "#046A38", changes: [{ fraction: 2 / 5, color: "#DA291C" }] },
  fr: { name: "Francia", initial: "#0055A4",
        changes: [{ fraction: 1 / 3, color: "#FFFFFF" }, { fraction: 2 / 3, color: "#EF4135" }] },
  de: { name: "Alemania", initial: "#FFCE00",
        changes: [{ fraction: 1 / 3, color: "#DD0000" }, { fraction: 2 / 3, color: "#000000" }] },
  it: { name: "Italia", initial: "#009246",
        changes: [{ fraction: 1 / 3, color: "#FFFFFF" }, { fraction: 2 / 3, color: "#CE2B37" }] },
};

function refreshColors() {
  if (!pf || !model) return;
  const c = colorsCfg();
  const { h, h1, n } = layerInfo();
  const list = sortedChanges().slice(0, MAX_CHANGES);
  bandUniforms.uBase.value.set(c.initial);
  bandUniforms.uCount.value = list.length;
  list.forEach((ch, i) => {
    bandUniforms.uCuts.value[i] = layerBottomZ(ch.layer, h, h1);
    bandUniforms.uCols.value[i].set(ch.color);
  });
  // planos de cambio y cama, en coordenadas de impresión
  const ctr = model.geometry.boundingSphere.center, R = pf.R;
  const cx = R[0][0] * ctr.x + R[0][1] * ctr.y + R[0][2] * ctr.z;
  const cy = R[1][0] * ctr.x + R[1][1] * ctr.y + R[1][2] * ctr.z;
  const size = model.geometry.boundingSphere.radius * 2.1;
  for (const m of planes.children) { m.geometry.dispose(); m.material.dispose(); }
  planes.clear();
  for (const ch of list) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: ch.color, transparent: true, side: THREE.DoubleSide, depthWrite: false,
                                    opacity: ch === selectedChange ? 0.4 : 0.14 }));
    pl.position.set(cx, cy, layerBottomZ(ch.layer, h, h1));
    planes.add(pl);
  }
  bed.visible = printView;
  bed.position.set(cx, cy, 0);
  document.getElementById("layerInfo").textContent = `${n} capas · ${pf.height.toFixed(1)} mm`;
  for (const row of document.querySelectorAll("#changes .chg")) {
    const ch = row._ch;
    const L = row.querySelector(".L");
    if (document.activeElement !== L) L.value = ch.layer;
    const frac = ch.fraction != null ? ` · ${FRACTION_NAMES[ch.fraction] || Math.round(ch.fraction * 100) + "%"}` : "";
    row.querySelector(".z").textContent = `Z ${ch.z.toFixed(2)} mm${frac}`;
    row.classList.toggle("sel", ch === selectedChange);
  }
  updateSlider();
}

function updateSlider() {
  const box = document.getElementById("layerBox");
  const ch = selectedChange;
  if (!ch || !colorsCfg().changes.includes(ch)) { box.style.display = "none"; return; }
  const { n } = layerInfo();
  const sl = document.getElementById("layerSlider");
  sl.max = n; sl.min = 2;
  if (document.activeElement !== sl) sl.value = ch.layer;
  document.getElementById("layerLabel").textContent = `Capa ${ch.layer} / ${n} · Z ${ch.z.toFixed(2)} mm`;
  box.style.display = "flex";
}

function selectChange(ch) {
  selectedChange = ch;
  refreshColors();
}

function setChangeLayer(ch, layer) {
  delete ch.fraction; // movido a mano: deja de ser "mitad", "tercio"…
  ch.layer = layer;
  refreshColors();
}

function renderColors() {
  const c = colorsCfg();
  document.getElementById("col0").value = c.initial;
  for (const [id, k] of [["lh", "layer_height"], ["fl", "first_layer"]]) {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = c[k];
  }
  const box = document.getElementById("changes");
  box.innerHTML = "";
  for (const ch of sortedChanges()) {
    const row = document.createElement("div");
    row.className = "chg";
    row._ch = ch;
    row.innerHTML = `<button class="small sel-btn" title="Mover con el deslizador del visor">⇕</button>
      <label class="inline">Capa <input class="L" type="number" min="2" step="1" value="${ch.layer}"></label>
      <span class="z"></span>
      <input class="C" type="color" value="${esc(ch.color)}" title="Color desde esta capa">
      <button class="small del" title="Quitar cambio">✕</button>`;
    row.querySelector(".sel-btn").addEventListener("click", () => selectChange(selectedChange === ch ? null : ch));
    row.querySelector(".L").addEventListener("focus", () => selectChange(ch));
    row.querySelector(".L").addEventListener("input", (e) => { if (+e.target.value >= 2) setChangeLayer(ch, +e.target.value); });
    row.querySelector(".C").addEventListener("input", (e) => { ch.color = e.target.value; refreshColors(); });
    row.querySelector(".del").addEventListener("click", () => {
      c.changes.splice(c.changes.indexOf(ch), 1);
      if (selectedChange === ch) selectedChange = null;
      renderColors();
    });
    box.appendChild(row);
  }
  refreshColors();
}

function addChange() {
  const c = colorsCfg();
  const { n } = layerInfo();
  const list = sortedChanges();
  let ch;
  if (!list.length) ch = { fraction: 0.5 };
  else {
    const last = list[list.length - 1].layer;
    if (last >= n) return;
    ch = { layer: Math.round((last + n) / 2) + 1 };
  }
  ch.color = PALETTE[c.changes.length % PALETTE.length];
  c.changes.push(ch);
  selectedChange = ch;
  renderColors();
}

function splitEqual(parts) {
  const c = colorsCfg();
  const old = sortedChanges();
  c.changes = Array.from({ length: parts - 1 }, (_, i) => ({
    fraction: (i + 1) / parts, color: old[i]?.color || PALETTE[i % PALETTE.length] }));
  selectedChange = null;
  renderColors();
}

function applyPreset(flag) {
  const c = colorsCfg();
  c.initial = flag.initial;
  c.changes = flag.changes.map((ch) => ({ ...ch }));
  selectedChange = null;
  renderColors();
}
document.querySelectorAll("[data-flag]").forEach((b) =>
  b.addEventListener("click", () => applyPreset(FLAGS[b.dataset.flag])));

document.getElementById("col0").addEventListener("input", (e) => { colorsCfg().initial = e.target.value; refreshColors(); });
for (const [id, k] of [["lh", "layer_height"], ["fl", "first_layer"]]) {
  document.getElementById(id).addEventListener("input", (e) => {
    if (+e.target.value > 0) { colorsCfg()[k] = +e.target.value; document.getElementById("heightsNote").textContent = ""; renderColors(); }
  });
}
document.getElementById("addChange").addEventListener("click", addChange);
document.querySelectorAll("[data-split]").forEach((b) => b.addEventListener("click", () => splitEqual(+b.dataset.split)));
document.getElementById("printView").addEventListener("change", (e) => setPrintView(e.target.checked));
document.getElementById("layerSlider").addEventListener("input", (e) => {
  if (selectedChange) setChangeLayer(selectedChange, +e.target.value);
  const row = [...document.querySelectorAll("#changes .chg")].find((r) => r._ch === selectedChange);
  if (row) row.querySelector(".L").value = selectedChange.layer;
});
document.querySelectorAll("#calib [data-pick]").forEach((b) =>
  b.addEventListener("click", () => setPicking(picking === b.dataset.pick ? null : b.dataset.pick)));
document.querySelectorAll("#calib [data-look]").forEach((b) => b.addEventListener("click", () => lookAt(b.dataset.look)));

// ------------------------------------------------------------------ laminado (solo programa de escritorio)
let slicerState = null;
const PRESET_LABEL = { machine: "impresora", process: "proceso", filament: "filamento" };

async function initSlicer() {
  const card = document.getElementById("sliceCard");
  const caps = await api.capabilities();
  if (!caps.slice) { card.remove(); return; }
  card.hidden = false;
  slicerState = await api.getSlicer();
  renderSlicer();
}

function renderSlicer() {
  const { config: cfg, presets, heights } = slicerState;
  document.getElementById("orcaPath").value = cfg.orca || "";
  for (const t of ["machine", "process", "filament"]) {
    const sel = document.getElementById("sel_" + t);
    const opts = (presets[t] || []).map((p) => [p.path, p.name]);
    if (cfg[t] && !opts.some((o) => o[0] === cfg[t])) opts.push([cfg[t], cfg[t].split(/[\\/]/).pop()]);
    sel.innerHTML = `<option value="">— elegir ${PRESET_LABEL[t]} —</option>`
      + opts.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join("")
      + `<option value="__pick__">Otro archivo .json…</option>`;
    sel.value = cfg[t] || "";
  }
  applyHeights(heights);
}

function applyHeights(h) {
  const note = document.getElementById("heightsNote");
  if (h && !h.error) {
    const c = colorsCfg();
    c.layer_height = h.layer_height;
    c.first_layer = h.first_layer;
    note.textContent = "Alturas de capa tomadas del perfil de proceso de OrcaSlicer.";
    renderColors();
  } else note.textContent = h?.error ? "⚠ " + h.error : "";
}

async function saveSlicerCfg() {
  const r = await api.putSlicer(slicerState.config);
  applyHeights(r.heights);
}

for (const t of ["machine", "process", "filament"]) {
  document.getElementById("sel_" + t).addEventListener("change", async (e) => {
    let v = e.target.value;
    if (v === "__pick__") {
      v = (await window.pywebview?.api?.pick_file("json")) || slicerState.config[t] || "";
    }
    slicerState.config[t] = v;
    await saveSlicerCfg();
    renderSlicer();
  });
}
document.getElementById("orcaPath").addEventListener("change", async (e) => {
  slicerState.config.orca = e.target.value.trim();
  await saveSlicerCfg();
});
document.getElementById("pickOrca").addEventListener("click", async () => {
  const p = await window.pywebview?.api?.pick_file("exe");
  if (p) { slicerState.config.orca = p; await saveSlicerCfg(); renderSlicer(); }
});

async function doSlice() {
  const btn = document.getElementById("sliceBtn");
  const out = document.getElementById("sliceStatus");
  readForm();
  btn.disabled = true;
  out.className = "";
  out.textContent = "Laminando con OrcaSlicer… (puede tardar un poco)";
  try {
    const { n } = layerInfo();
    const colors = structuredClone(colorsCfg());
    colors.changes = sortedChanges().map((ch) => ({ layer: ch.layer, color: ch.color, fraction: ch.fraction ?? null, z: ch.z }));
    const r = await api.slice({ ...jobs(), faces: currentFaces(), colors, predicted_layers: n });
    let msg = `✔ ${r.layers} capas` + (r.time ? ` · ${r.time}` : "") + (r.grams ? ` · ${r.grams} g` : "")
      + (r.changes.length ? ` · M600 en capa ${r.changes.map((c) => c.layer).join(", ")}` : " · sin cambios de color");
    if (r.warnings?.length) msg += "\n⚠ " + r.warnings.join("\n⚠ ");
    out.textContent = msg;
    out.className = r.warnings?.length ? "warn" : "";
    if (window.pywebview?.api?.save_gcode) {
      const s = await window.pywebview.api.save_gcode(r.name);
      out.textContent += "\n" + s.msg;
    } else {
      const a = document.createElement("a");
      a.href = "/api/last_gcode";
      a.download = r.name;
      a.click();
    }
  } catch (e) {
    out.textContent = "Error: " + e.message;
    out.className = "err";
  } finally {
    btn.disabled = false;
  }
}
document.getElementById("sliceBtn").addEventListener("click", doSlice);

// ------------------------------------------------------------------ acciones
let busy = false, again = false, timer = null;
function scheduleAuto() {
  if (!document.getElementById("auto").checked) return;
  clearTimeout(timer);
  timer = setTimeout(generate, 500);
}

async function generate() {
  if (busy) { again = true; return; }
  busy = true;
  readForm();
  setStatus("Generando…");
  try {
    const t0 = performance.now();
    const { buffer: buf, name, warnings } = await api.generate({ ...jobs(), faces: currentFaces() });
    lastBlob = new Blob([buf], { type: "model/stl" });
    lastName = name;
    showGeometry(buf);
    document.getElementById("download").disabled = false;
    const ms = Math.round(performance.now() - t0);
    if (warnings.length) setStatus("⚠ " + warnings.join("\n⚠ "), "warn");
    else setStatus(`Listo (${ms} ms). ${lastName}`);
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  } finally {
    busy = false;
    if (again) { again = false; generate(); }
  }
}

async function showTemplate() {
  showGeometry(await api.getTemplate());
}

async function download() {
  if (!lastBlob) return;
  if (window.pywebview?.api?.save_stl) { // programa de escritorio: diálogo "Guardar como"
    const r = await window.pywebview.api.save_stl(lastName);
    setStatus(r.msg, r.ok ? "" : "warn");
    return;
  }
  const file = new File([lastBlob], lastName, { type: "model/stl" });
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } // iOS: Guardar en Archivos / enviar
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(lastBlob);
  a.download = lastName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function save() {
  try {
    await api.saveFaces(currentFaces());
    setStatus("Ajustes guardados");
  } catch (e) { setStatus("Error al guardar: " + e.message, "err"); }
}

async function autodetect() {
  readForm();
  const texts = Object.fromEntries(FACES.map((f) => [f.key, config.faces[f.key]?.text || ""]));
  config.faces = await api.autodetect();
  for (const k in texts) if (config.faces[k]) config.faces[k].text = texts[k];
  buildForm(); drawMarkers(); updatePrintFrame(); renderColors();
  setStatus("Caras autodetectadas y guardadas.");
  scheduleAuto();
}

async function uploadTemplate(file) {
  setStatus("Cargando plantilla…");
  let out;
  try { out = await api.uploadTemplate(await file.arrayBuffer()); }
  catch (e) { setStatus("Error: " + e.message, "err"); return; }
  readForm();
  const texts = Object.fromEntries(FACES.map((f) => [f.key, config.faces[f.key]?.text || ""]));
  config.faces = out.faces;
  for (const k in texts) if (config.faces[k]) config.faces[k].text = texts[k];
  buildForm();
  showGeometry(await api.getTemplate(), true);
  drawMarkers();
  renderColors();
  setStatus(out.warning ? "⚠ " + out.warning : `Plantilla "${file.name}" cargada. Revisa las caras con "Ver".`,
            out.warning ? "warn" : "");
  scheduleAuto();
}
document.getElementById("templateFile").addEventListener("change", (e) => {
  if (e.target.files[0]) uploadTemplate(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("openTemplate").addEventListener("click", () => document.getElementById("templateFile").click());

async function resetTemplate() {
  readForm();
  const texts = Object.fromEntries(FACES.map((f) => [f.key, config.faces[f.key]?.text || ""]));
  config.faces = (await api.resetTemplate()).faces;
  for (const k in texts) if (config.faces[k]) config.faces[k].text = texts[k];
  buildForm();
  showGeometry(await api.getTemplate(), true);
  drawMarkers();
  renderColors();
  setStatus("Plantilla original restaurada.");
  scheduleAuto();
}
const resetBtn = document.getElementById("resetTemplate");
if (api.canResetTemplate) resetBtn.addEventListener("click", resetTemplate);
else resetBtn.remove();

document.getElementById("generate").addEventListener("click", generate);
document.getElementById("download").addEventListener("click", download);
document.getElementById("save").addEventListener("click", save);
document.getElementById("autodetect").addEventListener("click", autodetect);
document.getElementById("showTemplate").addEventListener("click", showTemplate);

// ------------------------------------------------------------------ inicio
(async () => {
  resize();
  render();
  config = await api.getConfig();
  buildForm();
  showGeometry(await api.getTemplate(), true);
  drawMarkers();
  renderColors();
  try { await initSlicer(); } catch (e) { console.error(e); document.getElementById("sliceCard")?.remove(); }
  window.__ready = true;
  window.__setPrintView = setPrintView;
})();
