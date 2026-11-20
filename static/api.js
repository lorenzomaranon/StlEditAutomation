// Capa de acceso: el mismo interfaz para el servidor Python (escritorio) y para el
// motor local en el navegador (versión web / móvil en GitHub Pages).

const FALLBACK_FONTS = ["DejaVuSans-Bold.ttf", "DejaVuSans.ttf"];

// ------------------------------------------------------------ servidor (FastAPI)
const serverApi = {
  mode: "server",
  async getConfig() { return (await fetch("/api/config")).json(); },
  async getTemplate() { return (await fetch("/api/template?t=" + Date.now())).arrayBuffer(); },
  async generate(jobs) {
    const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" },
                                               body: JSON.stringify(jobs) });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    return {
      buffer: await res.arrayBuffer(),
      name: decodeURIComponent(res.headers.get("X-Filename") || "resultado.stl"),
      warnings: JSON.parse(decodeURIComponent(res.headers.get("X-Warnings") || "[]")),
    };
  },
  async saveFaces(faces) {
    const res = await fetch("/api/faces", { method: "PUT", headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify(faces) });
    if (!res.ok) throw new Error("Error al guardar");
  },
  async autodetect() { return (await fetch("/api/autodetect", { method: "POST" })).json(); },
  async uploadTemplate(buffer) {
    const res = await fetch("/api/template", { method: "POST", body: buffer });
    const out = await res.json();
    if (!res.ok) throw new Error(out.detail);
    return out;
  },
  async capabilities() {
    try { return await (await fetch("/api/capabilities")).json(); } catch { return { slice: false }; }
  },
  async getSlicer() { return (await fetch("/api/slicer")).json(); },
  async putSlicer(cfg) {
    const res = await fetch("/api/slicer", { method: "PUT", headers: { "Content-Type": "application/json" },
                                             body: JSON.stringify(cfg) });
    return res.json();
  },
  async slice(body) {
    const res = await fetch("/api/slice", { method: "POST", headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.detail || res.statusText);
    return out;
  },
};

// ------------------------------------------------------------ local (navegador)
const LS_FACES = "grabadorstl.faces";
const idb = {
  open() {
    return new Promise((ok, ko) => {
      const r = indexedDB.open("grabadorstl", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
  },
  async get(key) {
    try {
      const db = await this.open();
      return await new Promise((ok, ko) => {
        const r = db.transaction("files").objectStore("files").get(key);
        r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
      });
    } catch { return undefined; }
  },
  async set(key, val) {
    const db = await this.open();
    await new Promise((ok, ko) => {
      const tx = db.transaction("files", "readwrite");
      val === undefined ? tx.objectStore("files").delete(key) : tx.objectStore("files").put(val, key);
      tx.oncomplete = ok; tx.onerror = () => ko(tx.error);
    });
  },
};

function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function lsSet(key, val) { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(val)); } catch { /* sin almacenamiento */ } }

function fileName(jobs) {
  const parts = ["front", "left", "right"].map((k) => (jobs[k]?.text || "").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, ""));
  return (parts.filter(Boolean).join("_") || "template") + ".stl";
}

function makeLocalApi() {
  let enginePromise = null, model = null, templateBuf = null, fontList = null;
  const fonts = {};

  const engine = () => (enginePromise ||= (async () => {
    const [{ default: Module }, opentype, eg] = await Promise.all([
      import("./vendor/manifold.js"), import("./vendor/opentype.module.js"), import("./engrave.js")]);
    const wasm = await Module();
    wasm.setup();
    return { wasm, opentype: opentype.default || opentype, eg };
  })());

  async function loadTemplate() {
    if (!templateBuf) {
      templateBuf = (await idb.get("template")) || (await (await fetch("template.stl")).arrayBuffer());
    }
    return templateBuf;
  }
  async function getModel() {
    if (!model) {
      const { wasm, eg } = await engine();
      model = new eg.Model(wasm, await loadTemplate());
    }
    return model;
  }
  async function getFont(name) {
    if (!fonts[name]) {
      const { opentype } = await engine();
      const res = await fetch("fonts/" + encodeURIComponent(name));
      if (!res.ok) throw new Error("Fuente no encontrada: " + name);
      fonts[name] = opentype.parse(await res.arrayBuffer());
    }
    return fonts[name];
  }
  async function defaultFaces() {
    if (await idb.get("template")) return (await getModel()).autodetectFaces();
    try { return await (await fetch("faces.json")).json(); } catch { return (await getModel()).autodetectFaces(); }
  }
  function keepSettings(oldFaces, newFaces) {
    for (const [k, f] of Object.entries(newFaces)) {
      if (k === "base") continue;
      for (const [p, v] of Object.entries(oldFaces[k] || {})) if (!["point", "normal", "up"].includes(p)) f[p] = v;
    }
    if (oldFaces.colors) newFaces.colors = oldFaces.colors;
    return newFaces;
  }

  return {
    mode: "local",
    canResetTemplate: true,
    async capabilities() { return { slice: false }; },
    async getConfig() {
      if (!fontList) {
        try { fontList = await (await fetch("fonts/index.json")).json(); } catch { fontList = FALLBACK_FONTS; }
      }
      engine(); // empezar a cargar el WASM en segundo plano
      const faces = lsGet(LS_FACES) || (await defaultFaces());
      if (!faces.base) { // ajustes guardados antes de existir la base: detectarla
        const b = (await getModel()).autodetectFaces().base;
        if (b) faces.base = b;
      }
      return { faces, fonts: fontList };
    },
    getTemplate: async () => (await loadTemplate()).slice(0),
    async generate(jobs) {
      const { eg } = await engine();
      const m = await getModel();
      const fontsUsed = {};
      for (const j of Object.values(jobs)) if (j.text?.trim()) fontsUsed[j.font] = await getFont(j.font);
      const faces = lsGet(LS_FACES) || (await defaultFaces());
      const r = eg.engrave(m, faces, jobs, fontsUsed);
      return { buffer: r.stl, name: fileName(jobs), warnings: r.warnings };
    },
    async saveFaces(faces) { lsSet(LS_FACES, faces); },
    async autodetect() {
      const faces = keepSettings(lsGet(LS_FACES) || {}, (await getModel()).autodetectFaces());
      lsSet(LS_FACES, faces);
      return faces;
    },
    async uploadTemplate(buffer) {
      const { wasm, eg } = await engine();
      const m = new eg.Model(wasm, buffer);
      try { m.manifold(); } catch (e) { throw new Error("No se pudo usar el STL: " + e.message); }
      await idb.set("template", buffer);
      templateBuf = buffer; model = m;
      return { faces: await this.autodetect(), warning: null };
    },
    async resetTemplate() {
      await idb.set("template", undefined);
      templateBuf = null; model = null;
      lsSet(LS_FACES, null);
      return { faces: await defaultFaces() };
    },
  };
}

const mode = document.querySelector('meta[name="engine"]')?.content
  || new URLSearchParams(location.search).get("engine")
  || "server";
export const api = mode === "local" ? makeLocalApi() : serverApi;
