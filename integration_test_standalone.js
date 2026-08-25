const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

const CASOS_OBLIGATORIOS = [
  ["Empleado 0759", 0, "Puntual"],
  ["Empleado 0800", 0, "Puntual"],
  ["Empleado 0805", 5, "Puntual"],
  ["Empleado 0810", 10, "Puntual"],
  ["Empleado 0811", 11, "Tardanza Leve"],
  ["Empleado 0820", 20, "Tardanza Leve"],
  ["Empleado 0829", 29, "Tardanza Leve"],
  ["Empleado 0830", 30, "Tardanza a Supervisar"],
  ["Empleado 0900", 60, "Tardanza a Supervisar"],
];

const { VirtualConsole } = require("jsdom");

async function main() {
  let html = fs.readFileSync(path.join(ROOT, "index_standalone.html"), "utf8");

  // Sustituir los <script src="https://cdn..."> externos ANTES de construir
  // el JSDOM, para que no intente ir a buscarlos a la red real (bloqueada en
  // este entorno de pruebas). XLSX se reemplaza por el bundle UMD real
  // (necesitamos el parseo real de Excel); Chart.js y jsPDF simplemente se
  // quitan, porque más abajo los sustituimos por stubs mínimos.
  const xlsxUmd = fs.readFileSync(path.join(ROOT, "node_modules", "xlsx", "dist", "xlsx.full.min.js"), "utf8");
  html = html
    .replace(
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>',
      () => `<script>${xlsxUmd}</script>` // función, NO string: evita que "$&" dentro del bundle se interprete como patrón especial de replace()
    )
    .replace('<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>', "")
    .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>', "")
    .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"></script>', "");

  // Reemplazar los <script src="local.js"> por su contenido inline, para que
  // jsdom los ejecute de forma NATIVA (runScripts:"dangerously") en vez de
  // usar window.eval() manual — así los `const`/`let` de nivel superior de
  // cada archivo comparten el mismo scope léxico global entre sí, tal como
  // ocurre en un navegador real con múltiples etiquetas <script>.
  const appJsCodigo = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const marcaInicioApp = "\n\n// ============================================================================\n// app.js";
  const idxInicioApp = html.indexOf(marcaInicioApp);
  if (idxInicioApp === -1) throw new Error("No se encontró el inicio de app.js dentro del bundle combinado");
  const idxCierreScript = html.indexOf("\n</script>", idxInicioApp);
  html = html.slice(0, idxInicioApp) + html.slice(idxCierreScript);

  const virtualConsole = new VirtualConsole();
  const erroresConsola = [];
  virtualConsole.on("jsdomError", (err) => {
    // Ignorar limitaciones conocidas del ENTORNO DE PRUEBA (jsdom), no del navegador real:
    // - fuentes/CSS externos bloqueados por la red restringida de este sandbox
    // - jsdom no implementa la navegación de <a>.click() para descargar blobs (sí funciona en cualquier navegador real)
    if (/Could not load link|ECONNREFUSED|Resource was not loaded|Not implemented: navigation/.test(err.message)) return;
    erroresConsola.push(err.message);
  });
  virtualConsole.on("error", (msg) => erroresConsola.push(msg));

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  const fdb = require("fake-indexeddb");
  window.indexedDB = new fdb.IDBFactory();
  window.IDBKeyRange = fdb.IDBKeyRange;

  window.Chart = class {
    constructor() {}
    destroy() {}
  };
  window.jspdf = { jsPDF: class {
    text(){}
    setFontSize(){}
    setTextColor(){}
    autoTable(){ this.lastAutoTable = { finalY: 0 }; }
    save(){}
    get internal() { return { pageSize: { getHeight: () => 27.9 } }; }
  } };
  window.alert = () => {};
  window.confirm = () => true;

  // Ahora sí, cargar app.js (comparte el scope léxico de los <script> ya
  // parseados porque runScripts:"dangerously" ejecuta cada <script> que se
  // inyecte de la misma forma que un navegador real).
  const scriptEl = window.document.createElement("script");
  scriptEl.textContent = appJsCodigo;
  window.document.body.appendChild(scriptEl);

  await new Promise((r) => setTimeout(r, 200));

  // --- Subir el Excel con los 9 casos obligatorios ---
  const bufExcel = fs.readFileSync(path.join(__dirname, "reporte_casos_obligatorios.xlsx"));
  const fakeFile = {
    name: "reporte_casos_obligatorios.xlsx",
    arrayBuffer: async () => new window.Uint8Array(bufExcel).buffer,
  };
  const fileInput = window.document.getElementById("fileInput");
  Object.defineProperty(fileInput, "files", { value: [fakeFile], writable: false });
  fileInput.dispatchEvent(new window.Event("change"));
  window.document.getElementById("procesarBtn").click();
  await new Promise((r) => setTimeout(r, 600));

  console.log("=== Resultado de la carga ===");
  console.log(window.document.getElementById("uploadStatus").textContent);
  console.log(window.document.getElementById("uploadResumen").textContent.replace(/\s+/g, " ").trim());

  // --- Verificar cada fila de la tabla renderizada contra la tabla obligatoria ---
  const filas = [...window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)")];
  console.log(`\nFilas en la tabla: ${filas.length} (se esperan 10)`);

  let todosOk = filas.length === 10;
  for (const [nombreEsperado, minEsperados, estadoEsperado] of CASOS_OBLIGATORIOS) {
    const fila = filas.find((tr) => tr.querySelector(".td-nombre").textContent.includes(nombreEsperado));
    if (!fila) {
      console.log(`❌ ${nombreEsperado}: no se encontró en la tabla`);
      todosOk = false;
      continue;
    }
    const celdas = fila.querySelectorAll("td");
    const minTexto = celdas[5].textContent.trim(); // "MIN. DESDE LAS 08:00"
    const estadoTexto = celdas[4].textContent.replace("●", "").trim(); // "ESTADO"
    const minOk = minTexto === `${minEsperados} min`;
    const estadoOk = estadoTexto === estadoEsperado;
    const ok = minOk && estadoOk;
    if (!ok) todosOk = false;
    console.log(
      `${ok ? "✅" : "❌"} ${nombreEsperado}: minutos="${minTexto}" (esperado "${minEsperados} min") | estado="${estadoTexto}" (esperado "${estadoEsperado}")`
    );
  }

  // --- Verificar formato de descanso con exceso: "61 min (+1 min)" ---
  const filaConDescanso = filas.find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado 0800"));
  const descansoTexto = filaConDescanso.querySelectorAll("td")[6].textContent.trim();
  console.log(`\nFormato de descanso con exceso: "${descansoTexto}" (esperado "61 min (+1 min)")`);
  if (descansoTexto !== "61 min (+1 min)") todosOk = false;

  // --- Verificar nuevas columnas: Horas trabajadas y Salida ---
  // Empleado 0759: entrada 07:59, salida 17:00, descanso 60 min -> bruto 9h01m, efectivas 8h01m -> Cumplida (>=8h)
  const fila0759 = filas.find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado 0759"));
  const celdas0759 = fila0759.querySelectorAll("td");
  const horasEfectivas0759 = celdas0759[9].textContent.trim();
  const jornadaTag0759 = celdas0759[10].textContent.replace("●", "").trim();
  console.log(`\nEmpleado 0759 — Horas efectivas: "${horasEfectivas0759}" (esperado "8h 01m") | Jornada: "${jornadaTag0759}" (esperado "Cumplida")`);
  if (horasEfectivas0759 !== "8h 01m" || jornadaTag0759 !== "Cumplida") todosOk = false;

  // Empleado Temprano: entrada 08:00, salida 16:00, descanso 60 min -> bruto 8h00m, efectivas 7h00m -> Incompleta (<8h)
  const filaTemprano = filas.find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado Temprano"));
  const celdasTemprano = filaTemprano.querySelectorAll("td");
  const horasEfectivasTemprano = celdasTemprano[9].textContent.trim();
  const jornadaTagTemprano = celdasTemprano[10].textContent.replace("●", "").trim();
  console.log(`Empleado Temprano — Horas efectivas: "${horasEfectivasTemprano}" (esperado "7h 00m") | Jornada: "${jornadaTagTemprano}" (esperado "Incompleta")`);
  if (horasEfectivasTemprano !== "7h 00m" || jornadaTagTemprano !== "Incompleta") todosOk = false;

  // --- Verificar KPIs: cantidad de tardanzas debe ser 5 (08:11, 08:20, 08:29, 08:30, 09:00) ---
  const kpiValores = [...window.document.querySelectorAll("#kpiRow .kpi-value")].map((el) => el.textContent.trim().replace(/\s+/g, " "));
  console.log(`\nKPIs (valores): ${kpiValores.join(" | ")}`);
  const cantidadTardanzasOk = kpiValores[2] === "5 eventos";
  console.log(`Cantidad de tardanzas = "5 eventos": ${cantidadTardanzasOk ? "✅" : "❌ obtuvo " + kpiValores[2]}`);
  if (!cantidadTardanzasOk) todosOk = false;

  // --- Verificar que no hay texto sin unidad tipo un numero suelto en celda de minutos ---
  const algunaCeldaSinUnidad = filas.some((tr) => {
    const txt = tr.querySelectorAll("td")[5].textContent.trim();
    return /^\d+$/.test(txt); // un número sin "min" sería un bug
  });
  console.log(`\n¿Alguna celda de minutos sin la palabra "min"?: ${algunaCeldaSinUnidad ? "❌ SI (bug)" : "✅ No"}`);
  if (algunaCeldaSinUnidad) todosOk = false;

  console.log("\n" + (todosOk ? "✅ TODOS LOS CASOS OBLIGATORIOS PASAN" : "❌ HAY CASOS QUE FALLAN"));

  // --- Probar el filtro de estado (multiselect propio) ---
  console.log("\n=== Probando filtro de estado (multiselect) ===");
  const msEstadoBtn = window.document.querySelector("#msEstado .multiselect-btn");
  console.log(`Botón antes de filtrar: "${msEstadoBtn.textContent}" (esperado "Todos los estados")`);
  msEstadoBtn.click();
  const checkboxLeve = [...window.document.querySelectorAll("#msEstado input[type=checkbox]")].find(
    (c) => c.value === "Tardanza Leve"
  );
  checkboxLeve.checked = true;
  checkboxLeve.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  console.log(`Botón tras seleccionar "Tardanza Leve": "${msEstadoBtn.textContent}"`);
  const filasFiltradasEstado = window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)").length;
  console.log(`Filas tras filtrar por "Tardanza Leve": ${filasFiltradasEstado} (esperado 3: 08:11, 08:20, 08:29)`);
  if (filasFiltradasEstado !== 3) todosOk = false;

  // --- Probar "Limpiar filtros" ---
  window.document.getElementById("limpiarFiltrosBtn").click();
  await new Promise((r) => setTimeout(r, 50));
  const filasTrasLimpiar = window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)").length;
  console.log(`Filas tras "Limpiar filtros": ${filasTrasLimpiar} (esperado 10)`);
  console.log(`Botón de estado tras limpiar: "${msEstadoBtn.textContent}" (esperado "Todos los estados")`);
  if (filasTrasLimpiar !== 10 || msEstadoBtn.textContent !== "Todos los estados") todosOk = false;

  // --- Probar exportación a Excel (no debe lanzar errores) ---
  // --- Probar carga de rutas asignadas y cumplimiento de cobertura ---
  console.log("\n=== Probando rutas asignadas y cobertura ===");
  const bufRutas = fs.readFileSync(path.join(__dirname, "reporte_rutas_asignadas.xlsx"));
  const fakeFileRutas = {
    name: "reporte_rutas_asignadas.xlsx",
    arrayBuffer: async () => new window.Uint8Array(bufRutas).buffer,
  };
  const fileInputRutas = window.document.getElementById("fileInputRutas");
  Object.defineProperty(fileInputRutas, "files", { value: [fakeFileRutas], writable: false });
  fileInputRutas.dispatchEvent(new window.Event("change"));
  window.document.getElementById("procesarRutasBtn").click();
  await new Promise((r) => setTimeout(r, 400));

  console.log("Estado de carga de rutas:", window.document.getElementById("rutasStatus").textContent);

  const filasTrasRutas = [...window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)")];
  const buscarCobertura = (nombre) => {
    const fila = filasTrasRutas.find((tr) => tr.querySelector(".td-nombre").textContent.includes(nombre));
    return fila?.querySelectorAll("td")[11]?.textContent.trim();
  };

  // Empleado 0759: ruta asignada "Tienda Centro" los sábados -> 15/08/2026 es sábado, y sí visitó -> cumplida (1/1)
  const cobertura0759 = buscarCobertura("Empleado 0759");
  console.log(`Empleado 0759 — Cobertura de ruta: "${cobertura0759}" (esperado "● 1/1")`);
  if (cobertura0759 !== "● 1/1") todosOk = false;

  // Empleado 0800: ruta asignada "Farmacia Norte" los sábados -> solo visitó "Tienda Centro" -> incompleta (0/1)
  const cobertura0800 = buscarCobertura("Empleado 0800");
  console.log(`Empleado 0800 — Cobertura de ruta: "${cobertura0800}" (esperado "● 0/1")`);
  if (cobertura0800 !== "● 0/1") todosOk = false;

  // Empleado 0805: tiene fila en el catálogo pero SIN día definido -> no se mide (—)
  const cobertura0805 = buscarCobertura("Empleado 0805");
  console.log(`Empleado 0805 (sin día definido) — Cobertura de ruta: "${cobertura0805}" (esperado "—")`);
  if (cobertura0805 !== "—") todosOk = false;

  // Empleado 0810: no aparece en absoluto en el catálogo de rutas -> no se mide (—)
  const cobertura0810 = buscarCobertura("Empleado 0810");
  console.log(`Empleado 0810 (sin fila en el catálogo) — Cobertura de ruta: "${cobertura0810}" (esperado "—")`);
  if (cobertura0810 !== "—") todosOk = false;

  // La ruta incompleta de Empleado 0800 debe aparecer como categoría nueva en "Atención requerida"
  const chipRuta = [...window.document.querySelectorAll(".atencion-chip[data-cat]")].find((b) =>
    b.textContent.includes("rutas incompletas")
  );
  console.log(`Chip "rutas incompletas" presente en Atención Requerida: ${!!chipRuta ? "✅" : "❌"}`);
  if (!chipRuta) todosOk = false;

  // --- Probar sincronización en vivo con Google Sheets (fetch simulado) ---
  // --- Probar el desplegable "Ruta del día" al tocar el nombre del colaborador ---
  console.log("\n=== Probando desplegable de ruta por colaborador ===");
  const filaEmpleado0800 = filasTrasRutas.find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado 0800"));
  const rowKey0800 = filaEmpleado0800.dataset.rowkey;
  const detalleRow0800 = window.document.querySelector(`[data-rowkey-detalle="${rowKey0800}"]`);
  console.log(`Detalle oculto antes de tocar: ${detalleRow0800.classList.contains("hidden") ? "✅" : "❌"}`);
  if (!detalleRow0800.classList.contains("hidden")) todosOk = false;

  filaEmpleado0800.querySelector(".td-expandible").click();
  await new Promise((r) => setTimeout(r, 50));
  console.log(`Detalle visible después de tocar: ${!detalleRow0800.classList.contains("hidden") ? "✅" : "❌"}`);
  if (detalleRow0800.classList.contains("hidden")) todosOk = false;

  // Empleado 0800 tiene ruta asignada (Farmacia Norte, sábados) que NO cumplió
  // (solo visitó Tienda Centro) -> debe verse la cruz ✗ y "Farmacia Norte" sin horario.
  const filasDetalle0800 = detalleRow0800.querySelectorAll(".detalle-ruta-tabla tbody tr");
  console.log(`Filas del detalle de Empleado 0800: ${filasDetalle0800.length} (esperado 1: Farmacia Norte)`);
  const textoFila0800 = filasDetalle0800[0]?.textContent || "";
  const tieneCruz = !!filasDetalle0800[0]?.querySelector(".check-no");
  console.log(`Detalle contiene "Farmacia Norte" con cruz de no visitado: ${textoFila0800.includes("Farmacia Norte") && tieneCruz ? "✅" : "❌"}`);
  if (!textoFila0800.includes("Farmacia Norte") || !tieneCruz) todosOk = false;

  // Empleado 0759 SÍ cumplió su ruta (Tienda Centro) -> debe verse el check ✓ con horario real
  const filaEmpleado0759 = filasTrasRutas.find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado 0759"));
  filaEmpleado0759.querySelector(".td-expandible").click();
  await new Promise((r) => setTimeout(r, 50));
  const detalleRow0759 = window.document.querySelector(`[data-rowkey-detalle="${filaEmpleado0759.dataset.rowkey}"]`);
  const filaDetalle0759 = detalleRow0759.querySelector(".detalle-ruta-tabla tbody tr");
  const tieneCheck0759 = !!filaDetalle0759?.querySelector(".check-ok");
  const horarioVisible0759 = filaDetalle0759?.textContent.includes("07:59") || filaDetalle0759?.textContent.includes("12:00");
  console.log(`Empleado 0759 — check de visitado: ${tieneCheck0759 ? "✅" : "❌"} | horario visible: ${horarioVisible0759 ? "✅" : "❌"}`);
  if (!tieneCheck0759 || !horarioVisible0759) todosOk = false;

  // Empleado 0810 no tiene ruta asignada (en este punto, antes del test de
  // sincronización) -> el detalle debe mostrar sus visitas reales sin checks.
  const filaEmpleado0810 = filasTrasRutas.find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado 0810"));
  filaEmpleado0810.querySelector(".td-expandible").click();
  await new Promise((r) => setTimeout(r, 50));
  const detalleRow0810 = window.document.querySelector(`[data-rowkey-detalle="${filaEmpleado0810.dataset.rowkey}"]`);
  const textoDetalle0810 = detalleRow0810.textContent;
  console.log(`Empleado 0810 (sin ruta asignada) — mensaje de "no tiene ruta asignada": ${textoDetalle0810.includes("no tiene ruta asignada") ? "✅" : "❌"}`);
  if (!textoDetalle0810.includes("no tiene ruta asignada")) todosOk = false;
  const sinChecks0810 = !detalleRow0810.querySelector(".check-ok, .check-no");
  console.log(`Empleado 0810 — sin columna de check (no hay nada que comparar): ${sinChecks0810 ? "✅" : "❌"}`);
  if (!sinChecks0810) todosOk = false;

  console.log("\n=== Probando sincronización en vivo de rutas (Google Sheets) ===");
  const csvSimulado =
    "Cliente,Persona de Interes,Punto de venta,VISITA,IDENTIFICADOR\n" +
    "Cliente A,Empleado 0810,Tienda Centro,SA,PDV0001\n";
  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => csvSimulado,
  });
  window.document.getElementById("rutasSheetUrl").value = "https://docs.google.com/fake/pub?output=csv";
  window.document.getElementById("rutasSheetUrl").dispatchEvent(new window.Event("change"));
  window.document.getElementById("sincronizarRutasBtn").click();
  await new Promise((r) => setTimeout(r, 300));

  const syncStatusTexto = window.document.getElementById("rutasSyncStatus").textContent;
  console.log(`Estado de sincronización: "${syncStatusTexto}" (esperado que incluya "correctamente")`);
  if (!syncStatusTexto.includes("correctamente")) todosOk = false;

  const syncInfoTexto = window.document.getElementById("rutasSyncInfo").textContent;
  console.log(`Info de última sincronización: "${syncInfoTexto}" (debe mencionar una fecha)`);
  if (!syncInfoTexto.includes("Última sincronización")) todosOk = false;

  // El nuevo catálogo (sincronizado) reemplaza al anterior (subido manualmente):
  // ahora Empleado 0810 SÍ tiene ruta asignada (antes no tenía ninguna).
  const filasTrasSync = [...window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)")];
  const cobertura0810TrasSync = filasTrasSync
    .find((tr) => tr.querySelector(".td-nombre").textContent.includes("Empleado 0810"))
    ?.querySelectorAll("td")[11]?.textContent.trim();
  console.log(`Empleado 0810 tras sincronizar — Cobertura de ruta: "${cobertura0810TrasSync}" (esperado "● 1/1")`);
  if (cobertura0810TrasSync !== "● 1/1") todosOk = false;

  // --- Probar manejo de error de red en la sincronización ---
  window.fetch = async () => {
    throw new Error("Failed to fetch");
  };
  window.document.getElementById("sincronizarRutasBtn").click();
  await new Promise((r) => setTimeout(r, 200));
  const syncErrorTexto = window.document.getElementById("rutasSyncStatus").textContent;
  console.log(`Estado tras fallo de red simulado: "${syncErrorTexto}" (esperado que incluya "Error")`);
  if (!syncErrorTexto.includes("Error")) todosOk = false;

  console.log("\n=== Probando exportación a Excel ===");
  window.Blob = function (parts) { this.parts = parts; };
  window.URL.createObjectURL = () => "blob://fake";
  window.URL.revokeObjectURL = () => {};
  try {
    window.document.getElementById("exportExcelBtn").click();
    await new Promise((r) => setTimeout(r, 100));
    console.log("✅ exportExcelBtn no lanzó errores");
  } catch (e) {
    console.log("❌ exportExcelBtn lanzó un error:", e.message);
    todosOk = false;
  }

  // --- Probar exportación a PDF (no debe lanzar errores) ---
  console.log("\n=== Probando exportación a PDF ===");
  try {
    window.document.getElementById("exportPdfBtn").click();
    await new Promise((r) => setTimeout(r, 100));
    console.log("✅ exportPdfBtn no lanzó errores");
  } catch (e) {
    console.log("❌ exportPdfBtn lanzó un error:", e.message);
    todosOk = false;
  }

  // --- Probar recalculación al guardar reglas de negocio ---
  console.log("\n=== Probando recalculación al guardar reglas de negocio ===");
  try {
    window.document.getElementById("cfgTolerancia").value = "5";
    window.document.getElementById("guardarCfgBtn").click();
    await new Promise((r) => setTimeout(r, 200));
    // Con tolerancia=5, la entrada 08:10 (10 min) deja de ser Puntual y pasa a Tardanza Leve
    const filaOtra = [...window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)")].find((tr) =>
      tr.querySelector(".td-nombre").textContent.includes("Empleado 0810")
    );
    const estadoTrasRecalculo = filaOtra?.querySelectorAll("td")[4]?.textContent.replace("●", "").trim();
    console.log(`Empleado 0810 tras bajar tolerancia a 5 min: "${estadoTrasRecalculo}" (esperado "Tardanza Leve")`);
    if (estadoTrasRecalculo !== "Tardanza Leve") todosOk = false;
    // Revertir para no afectar las pruebas siguientes
    window.document.getElementById("cfgTolerancia").value = "10";
    window.document.getElementById("guardarCfgBtn").click();
    await new Promise((r) => setTimeout(r, 200));
  } catch (e) {
    console.log("❌ guardarCfgBtn lanzó un error:", e.message);
    todosOk = false;
  }

  // --- Probar "Atención requerida" (franja de inconsistencias reales) ---
  console.log("\n=== Probando franja 'Atención requerida' ===");
  const atencionEl = window.document.getElementById("atencionRequerida");
  const tieneAlerta = atencionEl.classList.contains("atencion-alerta");
  console.log(`Franja muestra alerta (hay inconsistencias reales): ${tieneAlerta ? "✅" : "❌"}`);
  if (!tieneAlerta) todosOk = false;
  const chipDescanso = [...atencionEl.querySelectorAll(".atencion-chip[data-cat]")].find((b) =>
    b.textContent.includes("descansos excedidos")
  );
  console.log(`Chip "descansos excedidos" presente: ${!!chipDescanso ? "✅" : "❌"}`);
  if (chipDescanso) {
    chipDescanso.click();
    await new Promise((r) => setTimeout(r, 50));
    const filasTrasChip = window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)").length;
    console.log(`Filas tras filtrar por categoría "descansos excedidos": ${filasTrasChip} (esperado 1: Empleado 0800)`);
    if (filasTrasChip !== 1) todosOk = false;
    // Quitar el filtro de categoría para no afectar las pruebas siguientes
    window.document.getElementById("atencionQuitarFiltro")?.click();
    await new Promise((r) => setTimeout(r, 50));
  } else {
    todosOk = false;
  }

  // --- Probar historial de procesos (datos reales de IndexedDB, no fijos) ---
  console.log("\n=== Probando historial de procesos ===");
  const historialItems = window.document.querySelectorAll("#historialProcesos .hp-item");
  console.log(`Ítems en el historial: ${historialItems.length} (esperado 1, el período recién cargado)`);
  if (historialItems.length !== 1) todosOk = false;
  const dotClase = historialItems[0]?.querySelector(".hp-dot")?.className || "";
  console.log(`Punto de estado del historial: "${dotClase}" (debe incluir hp-dot-amarillo, porque este archivo generó una inconsistencia)`);
  if (!dotClase.includes("hp-dot-amarillo")) todosOk = false;

  // --- Probar filtro de PDV ---
  console.log("\n=== Probando filtro de PDV ===");
  const msPdvBtn = window.document.querySelector("#msPdv .multiselect-btn");
  msPdvBtn.click();
  const opcionesPdv = [...window.document.querySelectorAll("#msPdv input[type=checkbox]")];
  console.log(`Opciones de PDV detectadas: ${opcionesPdv.map((o) => o.value).join(", ")}`);
  if (opcionesPdv.length) {
    opcionesPdv[0].checked = true;
    opcionesPdv[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const filasTrasPdv = window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)").length;
    console.log(`Filas tras filtrar por PDV "${opcionesPdv[0].value}": ${filasTrasPdv}`);
    // Limpiar para no afectar pruebas siguientes
    window.document.getElementById("limpiarFiltrosBtn").click();
    await new Promise((r) => setTimeout(r, 50));
  }

  // --- Probar búsqueda de colaborador ---
  console.log("\n=== Probando búsqueda de colaborador ===");
  const buscarInput = window.document.getElementById("buscarColaboradorInput");
  buscarInput.value = "0811";
  buscarInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const filasTrasBusqueda = window.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)").length;
  console.log(`Filas tras buscar "0811": ${filasTrasBusqueda} (esperado 1)`);
  if (filasTrasBusqueda !== 1) todosOk = false;
  buscarInput.value = "";
  buscarInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  // --- Probar paginación (con solo 9 filas y 15 por página, debe caber todo en 1 página) ---
  console.log("\n=== Probando paginación ===");
  const paginacionInfo = window.document.getElementById("paginacionInfo").textContent;
  console.log(`Info de paginación: "${paginacionInfo}" (esperado que mencione 10 registros)`);
  if (!paginacionInfo.includes("10")) todosOk = false;
  const filasPorPaginaSelect = window.document.getElementById("filasPorPaginaSelect");
  filasPorPaginaSelect.value = "10";
  filasPorPaginaSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  console.log(`Cambio de filas por página no lanzó errores: ✅`);

  console.log("\n=== Probando comportamiento al 'reabrir la pestaña' (mismo IndexedDB) ===");
  const dom2 = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", resources: "usable", virtualConsole });
  const w2 = dom2.window;
  w2.indexedDB = window.indexedDB; // mismo "disco" simulado, como si fuera el mismo navegador
  w2.IDBKeyRange = fdb.IDBKeyRange;
  w2.Chart = class { constructor(){} destroy(){} };
  w2.jspdf = { jsPDF: class {
    text(){}
    setFontSize(){}
    setTextColor(){}
    autoTable(){ this.lastAutoTable = { finalY: 0 }; }
    save(){}
    get internal() { return { pageSize: { getHeight: () => 27.9 } }; }
  } };
  w2.alert = () => {};
  w2.confirm = () => true;
  const scriptEl2 = w2.document.createElement("script");
  scriptEl2.textContent = appJsCodigo;
  w2.document.body.appendChild(scriptEl2);
  await new Promise((r) => setTimeout(r, 300));

  const emptyVisibleTrasReabrir = !w2.document.getElementById("emptyState").classList.contains("hidden");
  const dashboardOcultoTrasReabrir = w2.document.getElementById("dashboardContent").classList.contains("hidden");
  console.log(`emptyState visible al reabrir: ${emptyVisibleTrasReabrir} (esperado true)`);
  console.log(`dashboardContent oculto al reabrir: ${dashboardOcultoTrasReabrir} (esperado true, aunque ya hay 10 registros guardados)`);
  if (!emptyVisibleTrasReabrir || !dashboardOcultoTrasReabrir) todosOk = false;

  const textoEmptyState = w2.document.getElementById("emptyStateTexto").textContent;
  console.log(`Texto del empty state menciona datos guardados: ${textoEmptyState.includes("datos guardados")}`);
  const botonVerHistorialVisible = !w2.document.getElementById("verHistorialBtn").classList.contains("hidden");
  console.log(`Botón "Ver historial guardado" visible: ${botonVerHistorialVisible} (esperado true)`);
  if (!botonVerHistorialVisible) todosOk = false;

  // Pulsar el botón debe revelar el dashboard con los datos ya guardados
  w2.document.getElementById("verHistorialBtn").click();
  await new Promise((r) => setTimeout(r, 200));
  const dashboardVisibleTrasBoton = !w2.document.getElementById("dashboardContent").classList.contains("hidden");
  const filasTrasBoton = w2.document.querySelectorAll("#tablaAuditoria > tbody > tr:not(.fila-detalle-ruta)").length;
  console.log(`dashboardContent visible tras pulsar "Ver historial guardado": ${dashboardVisibleTrasBoton} (esperado true)`);
  console.log(`Filas en la tabla tras pulsar el botón: ${filasTrasBoton} (esperado 10)`);
  if (!dashboardVisibleTrasBoton || filasTrasBoton !== 10) todosOk = false;

  console.log("\n=== Errores de consola del navegador durante toda la ejecución ===");
  if (erroresConsola.length) {
    erroresConsola.forEach((m) => console.log("❌", m));
    todosOk = false;
  } else {
    console.log("✅ Cero errores de consola (excluyendo bloqueos de red esperados en este sandbox de prueba)");
  }

  console.log("\n" + (todosOk ? "✅ RESULTADO FINAL: TODO CORRECTO" : "❌ RESULTADO FINAL: HAY FALLAS"));
  process.exit(todosOk ? 0 : 1);
}

main().catch((e) => {
  console.error("❌ ERROR EN TEST:", e);
  process.exit(1);
});
