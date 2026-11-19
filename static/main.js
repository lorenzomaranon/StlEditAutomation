import * as THREE from "three";
import { STLLoader } from "./vendor/STLLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";

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
let model = null;
const markers = new THREE.Group();
scene.add(markers);

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
  if (model) { scene.remove(model); model.geometry.dispose(); }
  model = new THREE.Mesh(geom, material);
  scene.add(model);
  if (fit) {
    geom.computeBoundingSphere();
    const { center, radius } = geom.boundingSphere;
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(1.6, -2.2, 1.4).normalize().multiplyScalar(radius * 3.2));
    camera.near = radius / 50; camera.far = radius * 50;
    camera.updateProjectionMatrix();
  }
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
}

function lookAt(key) {
  const c = config.faces[key];
  if (!c || !model) return;
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
    hint.textContent = `Haz clic en la cara ${FACES.find((f) => f.key === key).label.toLowerCase()} (centro del texto)`;
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
      <div class="grid">
        <label>Altura (mm)<input data-k="height" type="number" step="0.5" min="0.5" value="${c.height}"></label>
        <label>Profund. (mm)<input data-k="depth" type="number" step="0.1" min="0.1" value="${c.depth}"></label>
        <label>Giro (°)<input data-k="rotation" type="number" step="90" value="${c.rotation}"></label>
        <label>Mover → (mm)<input data-k="ox" type="number" step="0.5" value="${c.offset[0]}"></label>
        <label>Mover ↑ (mm)<input data-k="oy" type="number" step="0.5" value="${c.offset[1]}"></label>
        <label>Espaciado<input data-k="spacing" type="number" step="0.1" value="${c.spacing}"></label>
      </div>
      <label style="margin-top:6px">Fuente<select data-k="font">${fontOpts}</select></label>`;
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

function setStatus(msg, cls = "") {
  const s = document.getElementById("status");
  s.textContent = msg; s.className = cls;
}

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
    const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" },
                                               body: JSON.stringify(jobs()) });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const buf = await res.arrayBuffer();
    lastBlob = new Blob([buf], { type: "model/stl" });
    lastName = decodeURIComponent(res.headers.get("X-Filename") || "resultado.stl");
    showGeometry(buf);
    const warnings = JSON.parse(decodeURIComponent(res.headers.get("X-Warnings") || "[]"));
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
  const buf = await (await fetch("/api/template?t=" + Date.now())).arrayBuffer();
  showGeometry(buf);
}

async function download() {
  if (!lastBlob) return;
  if (window.pywebview?.api?.save_stl) { // programa de escritorio: diálogo "Guardar como"
    const r = await window.pywebview.api.save_stl(lastName);
    setStatus(r.msg, r.ok ? "" : "warn");
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(lastBlob);
  a.download = lastName;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function save() {
  readForm();
  const faces = structuredClone(config.faces);
  for (const k in faces) delete faces[k].text; // los textos no se guardan
  const res = await fetch("/api/faces", { method: "PUT", headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify(faces) });
  setStatus(res.ok ? "Ajustes guardados" : "Error al guardar", res.ok ? "" : "err");
}

async function autodetect() {
  readForm();
  const texts = Object.fromEntries(FACES.map((f) => [f.key, config.faces[f.key]?.text || ""]));
  config.faces = await (await fetch("/api/autodetect", { method: "POST" })).json();
  for (const k in texts) if (config.faces[k]) config.faces[k].text = texts[k];
  buildForm(); drawMarkers();
  setStatus("Caras autodetectadas y guardadas.");
  scheduleAuto();
}

async function uploadTemplate(file) {
  setStatus("Cargando plantilla…");
  const res = await fetch("/api/template", { method: "POST", body: await file.arrayBuffer() });
  const out = await res.json();
  if (!res.ok) { setStatus("Error: " + out.detail, "err"); return; }
  readForm();
  const texts = Object.fromEntries(FACES.map((f) => [f.key, config.faces[f.key]?.text || ""]));
  config.faces = out.faces;
  for (const k in texts) if (config.faces[k]) config.faces[k].text = texts[k];
  buildForm();
  const buf = await (await fetch("/api/template?t=" + Date.now())).arrayBuffer();
  showGeometry(buf, true);
  drawMarkers();
  setStatus(out.warning ? "⚠ " + out.warning : `Plantilla "${file.name}" cargada. Revisa las caras con "Ver".`,
            out.warning ? "warn" : "");
  scheduleAuto();
}
document.getElementById("templateFile").addEventListener("change", (e) => {
  if (e.target.files[0]) uploadTemplate(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("openTemplate").addEventListener("click", () => document.getElementById("templateFile").click());

document.getElementById("generate").addEventListener("click", generate);
document.getElementById("download").addEventListener("click", download);
document.getElementById("save").addEventListener("click", save);
document.getElementById("autodetect").addEventListener("click", autodetect);
document.getElementById("showTemplate").addEventListener("click", showTemplate);

// ------------------------------------------------------------------ inicio
(async () => {
  resize();
  render();
  config = await (await fetch("/api/config")).json();
  buildForm();
  const buf = await (await fetch("/api/template?t=" + Date.now())).arrayBuffer();
  showGeometry(buf, true);
  drawMarkers();
  window.__ready = true;
})();
