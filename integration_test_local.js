const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    resources: "usable",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // --- IndexedDB simulado (misma API que un navegador real) ---
  const fdb = require("fake-indexeddb");
  window.indexedDB = new fdb.IDBFactory();
  window.IDBKeyRange = fdb.IDBKeyRange;

  // --- Chart.js stub (jsdom no soporta canvas real) ---
  window.Chart = class {
    constructor() {}
    destroy() {}
  };
  window.jspdf = { jsPDF: class { text(){} autoTable(){return {finalY:0};} save(){} } };

  // --- XLSX real, cargado en el MISMO realm que window (ver notas de la prueba anterior) ---
  const xlsxUmd = fs.readFileSync(path.join(ROOT, "node_modules", "xlsx", "dist", "xlsx.full.min.js"), "utf8");
  window.eval(xlsxUmd);

  // Cargar los scripts reales de la app, en orden
  for (const archivo of ["db.js", "etl.js", "businessLogic.js", "reportsClient.js", "app.js"]) {
    const codigo = fs.readFileSync(path.join(ROOT, archivo), "utf8");
    window.eval(codigo);
  }

  await new Promise((r) => setTimeout(r, 200)); // dejar correr arrancarApp()

  console.log("=== Estado inicial (sin datos) ===");
  console.log("emptyState visible:", !window.document.getElementById("emptyState").classList.contains("hidden"));

  // --- Simular subida de Excel ---
  const bufExcel = fs.readFileSync(path.join(__dirname, "reporte_prueba.xlsx"));
  const fakeFile = {
    name: "reporte_prueba.xlsx",
    arrayBuffer: async () => new window.Uint8Array(bufExcel).buffer,
  };
  const fileInput = window.document.getElementById("fileInput");
  Object.defineProperty(fileInput, "files", { value: [fakeFile], writable: false });
  fileInput.dispatchEvent(new window.Event("change"));
  window.document.getElementById("procesarBtn").click();
  await new Promise((r) => setTimeout(r, 500));

  console.log("\n=== Después de procesar el Excel ===");
  console.log("uploadStatus:", window.document.getElementById("uploadStatus").textContent);

  const empleados = await new Promise((resolve) => {
    const req = window.indexedDB.open("asistencia_pdv_db");
    req.onsuccess = () => {
      const tx = req.result.transaction("empleados", "readonly");
      const r = tx.objectStore("empleados").getAll();
      r.onsuccess = () => resolve(r.result);
    };
  });
  console.log("Empleados en IndexedDB:", empleados.length);

  console.log("\n=== Estado del dashboard tras cargar datos ===");
  console.log("dashboardContent visible:", !window.document.getElementById("dashboardContent").classList.contains("hidden"));
  console.log("KPIs:", window.document.getElementById("kpiRow").textContent.replace(/\s+/g, " ").trim());
  console.log("Filas en tabla:", window.document.querySelectorAll("#tablaAuditoria tbody tr").length);

  // Verificar que la tira de ruta (firma visual) se renderizó
  const primeraFilaRuta = window.document.querySelector("#tablaAuditoria tbody tr td:last-child").innerHTML;
  console.log("Tira de ruta (primera fila):", primeraFilaRuta.slice(0, 120).replace(/\s+/g, " "));

  // --- Probar filtro por estado "Tardanza Grave" ---
  const selEstado = window.document.getElementById("filtroEstado");
  [...selEstado.options].forEach((o) => (o.selected = o.value === "Tardanza Grave"));
  selEstado.dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 50));
  console.log('Filas tras filtrar "Tardanza Grave":', window.document.querySelectorAll("#tablaAuditoria tbody tr").length);

  // --- Probar recarga de la página (persistencia real entre "sesiones") ---
  console.log("\n=== Simulando recarga de página (nueva instancia de window) ===");
  const dom2 = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", resources: "usable" });
  const w2 = dom2.window;
  w2.indexedDB = window.indexedDB; // mismo "disco" simulado, como si fuera el mismo navegador
  w2.IDBKeyRange = fdb.IDBKeyRange;
  w2.Chart = class { constructor(){} destroy(){} };
  w2.jspdf = { jsPDF: class { text(){} autoTable(){return {finalY:0};} save(){} } };
  w2.eval(xlsxUmd);
  for (const archivo of ["db.js", "etl.js", "businessLogic.js", "reportsClient.js", "app.js"]) {
    w2.eval(fs.readFileSync(path.join(ROOT, archivo), "utf8"));
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log("Tras 'recargar': dashboardContent visible:", !w2.document.getElementById("dashboardContent").classList.contains("hidden"));
  console.log("Tras 'recargar': filas en tabla:", w2.document.querySelectorAll("#tablaAuditoria tbody tr").length);

  console.log("\n✅ TEST DE INTEGRACIÓN COMPLETADO SIN ERRORES");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ ERROR EN TEST:", e);
  process.exit(1);
});
