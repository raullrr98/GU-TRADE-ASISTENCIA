// ============================================================================
// app.js — Orquestador principal, 100% local (sin backend, sin Supabase).
// Todo el procesamiento y almacenamiento ocurre en este navegador (IndexedDB).
// ============================================================================

let charts = { ranking: null, evolucion: null, distribucion: null, tendencia: null };
let cacheResumen = [];
let periodosDisponibles = [];

// ---------------------------------------------------------------------------
// RELOJ DEL ENCABEZADO (detalle de ambientación, sin dependencias)
// ---------------------------------------------------------------------------
function actualizarReloj() {
  const el = document.getElementById("relojHeader");
  if (!el) return;
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" });
  const hora = ahora.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  el.textContent = `${fecha} · ${hora}`;
}
setInterval(actualizarReloj, 15000);

// ---------------------------------------------------------------------------
// CONFIGURACIÓN DE NEGOCIO
// ---------------------------------------------------------------------------
async function cargarConfiguracion() {
  const filas = await dbGetAll("configuracion");
  const cfg = {};
  filas.forEach((row) => (cfg[row.clave] = row.valor));
  return {
    horaEntradaTeorica: cfg.hora_entrada_teorica || "08:00",
    toleranciaMin: parseInt(cfg.tolerancia_min || "10", 10),
    tardanzaLeveMaxMin: parseInt(cfg.tardanza_leve_max_min || "15", 10),
    descansoPermitidoMin: parseInt(cfg.descanso_permitido_min || "60", 10),
  };
}

async function poblarPanelConfiguracion() {
  const cfg = await cargarConfiguracion();
  document.getElementById("cfgHoraEntrada").value = cfg.horaEntradaTeorica;
  document.getElementById("cfgTolerancia").value = cfg.toleranciaMin;
  document.getElementById("cfgTardanzaLeve").value = cfg.tardanzaLeveMaxMin;
  document.getElementById("cfgDescanso").value = cfg.descansoPermitidoMin;
}

document.getElementById("guardarCfgBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("cfgStatus");
  statusEl.textContent = "Guardando y recalculando...";
  statusEl.className = "status-msg";
  try {
    await dbPutMany("configuracion", [
      { clave: "hora_entrada_teorica", valor: document.getElementById("cfgHoraEntrada").value.trim() },
      { clave: "tolerancia_min", valor: document.getElementById("cfgTolerancia").value },
      { clave: "tardanza_leve_max_min", valor: document.getElementById("cfgTardanzaLeve").value },
      { clave: "descanso_permitido_min", valor: document.getElementById("cfgDescanso").value },
    ]);
    await recalcularTodoElHistorico();
    statusEl.textContent = "Configuración guardada y datos recalculados.";
    statusEl.classList.add("ok");
    await refrescarPeriodosYVista();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  }
});

async function recalcularTodoElHistorico() {
  const periodos = await dbGetAll("periodos_cargados");
  const config = await cargarConfiguracion();
  for (const { periodo } of periodos) {
    const marcaciones = await dbGetByIndex("marcaciones_detalle", "periodo", periodo);
    const resumenes = calcularResumen(marcaciones, config);
    await guardarResumenes(periodo, resumenes);
  }
}

// ---------------------------------------------------------------------------
// BORRAR TODOS LOS DATOS LOCALES
// ---------------------------------------------------------------------------
document.getElementById("borrarDatosBtn").addEventListener("click", async () => {
  const ok = confirm(
    "Esto borra TODO el histórico guardado en este navegador (todos los meses cargados). ¿Continuar?"
  );
  if (!ok) return;
  await dbClearAll();
  await asegurarConfiguracionInicial();
  location.reload();
});

// ---------------------------------------------------------------------------
// INGESTA DE EXCEL
// ---------------------------------------------------------------------------
let archivoSeleccionado = null;

document.getElementById("fileInput").addEventListener("change", (e) => {
  archivoSeleccionado = e.target.files[0] || null;
  document.getElementById("procesarBtn").disabled = !archivoSeleccionado;
});

document.getElementById("procesarBtn").addEventListener("click", async () => {
  if (!archivoSeleccionado) return;
  const statusEl = document.getElementById("uploadStatus");
  statusEl.textContent = "Leyendo y procesando archivo...";
  statusEl.className = "status-msg";

  try {
    const arrayBuffer = await archivoSeleccionado.arrayBuffer();
    const filas = leerYLimpiarExcel(arrayBuffer);
    if (!filas.length) throw new Error("El archivo no contiene filas válidas.");

    const periodoManual = document.getElementById("periodoManual").value.trim();
    const periodo = periodoManual || detectarPeriodo(filas);

    // 1) Upsert de empleados (catálogo maestro)
    const empleadosUnicos = [...new Map(filas.map((f) => [f.id_empleado, f.nombre])).entries()].map(
      ([id_empleado, nombre]) => ({ id_empleado, nombre })
    );
    await dbPutMany("empleados", empleadosUnicos);

    // 2) Reemplazar marcaciones del periodo (borra + inserta, evita duplicar al resubir el mismo mes)
    await dbDeleteByIndex("marcaciones_detalle", "periodo", periodo);
    const marcacionesInsert = filas.map((f) => ({
      id_empleado: f.id_empleado,
      fecha: f.fecha,
      punto_venta: f.punto_venta,
      actividad: f.actividad,
      hora_inicio: f.hora_inicio,
      hora_salida: f.hora_salida,
      tiempo_transcurrido_min: f.tiempo_transcurrido_min,
      marcacion_abierta: f.marcacion_abierta,
      periodo: f.periodo,
    }));
    await dbPutMany("marcaciones_detalle", marcacionesInsert);

    // 3) Registrar el periodo cargado
    await dbPut("periodos_cargados", {
      periodo,
      nombre_archivo_original: archivoSeleccionado.name,
      filas_procesadas: marcacionesInsert.length,
      empleados_afectados: empleadosUnicos.length,
      fecha_carga: new Date().toISOString(),
    });

    // 4) Calcular reglas de negocio y guardar resumen diario
    const config = await cargarConfiguracion();
    const resumenes = calcularResumen(filas, config);
    await guardarResumenes(periodo, resumenes);

    statusEl.textContent = `Periodo ${periodo}: ${marcacionesInsert.length} filas, ${empleadosUnicos.length} colaboradores procesados.`;
    statusEl.classList.add("ok");

    await refrescarPeriodosYVista(periodo);
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  }
});

async function guardarResumenes(periodo, resumenes) {
  await dbDeleteByIndex("asistencia_resumen_diario", "periodo", periodo);
  await dbPutMany("asistencia_resumen_diario", resumenes);
}

// ---------------------------------------------------------------------------
// SELECTOR DE PERÍODO
// ---------------------------------------------------------------------------
async function cargarPeriodosDisponibles() {
  const data = await dbGetAll("periodos_cargados");
  periodosDisponibles = data.sort((a, b) => (a.periodo < b.periodo ? 1 : -1));
  return periodosDisponibles;
}

function poblarSelectoresPeriodo() {
  const periodoSelect = document.getElementById("periodoSelect");
  const periodoMulti = document.getElementById("periodoMulti");
  periodoSelect.innerHTML = "";
  periodoMulti.innerHTML = "";
  periodosDisponibles.forEach(({ periodo }) => {
    const opt1 = document.createElement("option");
    opt1.value = periodo;
    opt1.textContent = periodo;
    periodoSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = periodo;
    opt2.textContent = periodo;
    periodoMulti.appendChild(opt2);
  });
  if (periodosDisponibles.length) {
    periodoMulti.querySelectorAll("option")[0].selected = true;
    if (periodosDisponibles.length > 1) periodoMulti.querySelectorAll("option")[1].selected = true;
  }
}

function obtenerModoVista() {
  return document.querySelector('input[name="modoVista"]:checked').value;
}

function obtenerPeriodosSeleccionados() {
  const modo = obtenerModoVista();
  if (!periodosDisponibles.length) return [];
  if (modo === "actual") return [periodosDisponibles[0].periodo];
  if (modo === "especifico") return [document.getElementById("periodoSelect").value];
  return [...document.getElementById("periodoMulti").selectedOptions].map((o) => o.value);
}

document.getElementById("modoVistaGroup").addEventListener("change", () => {
  const modo = obtenerModoVista();
  document.getElementById("periodoSelect").classList.toggle("hidden", modo !== "especifico");
  document.getElementById("periodoMultiWrap").classList.toggle("hidden", modo !== "comparativa");
  renderizarVistaActual();
});
document.getElementById("periodoSelect").addEventListener("change", renderizarVistaActual);
document.getElementById("periodoMulti").addEventListener("change", renderizarVistaActual);

// ---------------------------------------------------------------------------
// CARGA DE DATOS DE RESUMEN (con nombre del empleado embebido)
// ---------------------------------------------------------------------------
async function obtenerResumenDf(periodos) {
  if (!periodos.length) return [];
  const filas = await dbGetByIndex("asistencia_resumen_diario", "periodo", periodos);
  const empleados = await dbGetAll("empleados");
  const nombresPorId = new Map(empleados.map((e) => [e.id_empleado, e.nombre]));
  return filas
    .map((r) => ({ ...r, nombre: nombresPorId.get(r.id_empleado) || r.id_empleado }))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
}

async function obtenerMarcacionesDf(periodo) {
  const filas = await dbGetByIndex("marcaciones_detalle", "periodo", periodo);
  const empleados = await dbGetAll("empleados");
  const nombresPorId = new Map(empleados.map((e) => [e.id_empleado, e.nombre]));
  return filas.map((r) => ({ ...r, nombre: nombresPorId.get(r.id_empleado) || r.id_empleado }));
}

// ---------------------------------------------------------------------------
// ORQUESTACIÓN GENERAL DE REFRESCO
// ---------------------------------------------------------------------------
async function refrescarPeriodosYVista(periodoAEnfocar) {
  await cargarPeriodosDisponibles();
  poblarSelectoresPeriodo();
  if (periodoAEnfocar) document.getElementById("periodoSelect").value = periodoAEnfocar;
  await renderizarVistaActual();
}

async function renderizarVistaActual() {
  if (!periodosDisponibles.length) {
    document.getElementById("emptyState").classList.remove("hidden");
    document.getElementById("dashboardContent").classList.add("hidden");
    return;
  }
  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("dashboardContent").classList.remove("hidden");

  const periodos = obtenerPeriodosSeleccionados();
  cacheResumen = await obtenerResumenDf(periodos);
  poblarFiltrosDinamicos(cacheResumen);
  aplicarFiltrosYRenderizar();
}

function poblarFiltrosDinamicos(df) {
  const empleados = [...new Set(df.map((r) => r.nombre))].sort();
  const estados = [...new Set(df.map((r) => r.clasificacion_puntualidad))].sort();

  const selEmp = document.getElementById("filtroEmpleado");
  const valoresEmpPrevios = new Set([...selEmp.selectedOptions].map((o) => o.value));
  selEmp.innerHTML = "";
  empleados.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    opt.selected = valoresEmpPrevios.has(n);
    selEmp.appendChild(opt);
  });

  const selEst = document.getElementById("filtroEstado");
  const valoresEstPrevios = new Set([...selEst.selectedOptions].map((o) => o.value));
  selEst.innerHTML = "";
  estados.forEach((e) => {
    const opt = document.createElement("option");
    opt.value = e;
    opt.textContent = e;
    opt.selected = valoresEstPrevios.has(e);
    selEst.appendChild(opt);
  });

  if (df.length) {
    const fechas = df.map((r) => r.fecha).sort();
    if (!document.getElementById("filtroFechaDesde").value) document.getElementById("filtroFechaDesde").value = fechas[0];
    if (!document.getElementById("filtroFechaHasta").value) document.getElementById("filtroFechaHasta").value = fechas[fechas.length - 1];
    document.getElementById("fechaPdf").value = fechas[fechas.length - 1];
  }
}

["filtroEmpleado", "filtroFechaDesde", "filtroFechaHasta", "filtroEstado"].forEach((id) => {
  document.getElementById(id).addEventListener("change", aplicarFiltrosYRenderizar);
});

function aplicarFiltrosYRenderizar() {
  const empSel = [...document.getElementById("filtroEmpleado").selectedOptions].map((o) => o.value);
  const estSel = [...document.getElementById("filtroEstado").selectedOptions].map((o) => o.value);
  const desde = document.getElementById("filtroFechaDesde").value;
  const hasta = document.getElementById("filtroFechaHasta").value;

  let df = cacheResumen;
  if (empSel.length) df = df.filter((r) => empSel.includes(r.nombre));
  if (estSel.length) df = df.filter((r) => estSel.includes(r.clasificacion_puntualidad));
  if (desde) df = df.filter((r) => r.fecha >= desde);
  if (hasta) df = df.filter((r) => r.fecha <= hasta);

  renderKPIs(df);
  renderGraficos(df);
  renderTabla(df);
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------
function renderKPIs(df) {
  const totalColaboradores = new Set(df.map((r) => r.id_empleado)).size;
  const totalDias = df.length;
  const puntuales = df.filter((r) => r.clasificacion_puntualidad === "Puntual").length;
  const pctPuntualidad = totalDias ? ((puntuales / totalDias) * 100).toFixed(1) : "0.0";
  const totalTardanzas = df.filter((r) => ["Tardanza Leve", "Tardanza Grave"].includes(r.clasificacion_puntualidad)).length;
  const minutosPerdidos = df.reduce((acc, r) => acc + (r.minutos_tardanza || 0), 0);
  const promPdvs = totalDias ? (df.reduce((acc, r) => acc + (r.pdvs_unicos_visitados || 0), 0) / totalDias).toFixed(1) : "0.0";

  const kpis = [
    { label: "Colaboradores", value: totalColaboradores },
    { label: "Puntualidad", value: `${pctPuntualidad}%` },
    { label: "Tardanzas", value: totalTardanzas },
    { label: "Min. Perdidos", value: minutosPerdidos },
    { label: "PDVs / Día", value: promPdvs },
  ];

  const row = document.getElementById("kpiRow");
  row.innerHTML = kpis
    .map((k) => `<div class="kpi-stub"><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div></div>`)
    .join("");
}

// ---------------------------------------------------------------------------
// GRÁFICOS (Chart.js)
// ---------------------------------------------------------------------------
function destruirChart(nombre) {
  if (charts[nombre]) {
    charts[nombre].destroy();
    charts[nombre] = null;
  }
}

function renderGraficos(df) {
  renderRanking(df);
  renderEvolucion(df);
  renderDistribucion(df);
  renderTendencia();
}

const FUENTE_UI = "Inter, sans-serif";

function renderRanking(df) {
  destruirChart("ranking");
  const conteo = new Map();
  df.filter((r) => ["Tardanza Leve", "Tardanza Grave"].includes(r.clasificacion_puntualidad)).forEach((r) => {
    conteo.set(r.nombre, (conteo.get(r.nombre) || 0) + 1);
  });
  const entradas = [...conteo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ctx = document.getElementById("chartRanking");
  charts.ranking = new Chart(ctx, {
    type: "bar",
    data: {
      labels: entradas.map((e) => e[0]),
      datasets: [{ label: "Tardanzas", data: entradas.map((e) => e[1]), backgroundColor: "#B23B32", borderRadius: 2, barThickness: 14 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { family: FUENTE_UI, size: 11 } }, grid: { color: "#E7E5DC" } },
        y: { ticks: { font: { family: FUENTE_UI, size: 11 } }, grid: { display: false } },
      },
    },
  });
}

function renderEvolucion(df) {
  destruirChart("evolucion");
  const porFechaEstado = new Map();
  df.forEach((r) => {
    if (!porFechaEstado.has(r.fecha)) porFechaEstado.set(r.fecha, {});
    const obj = porFechaEstado.get(r.fecha);
    obj[r.clasificacion_puntualidad] = (obj[r.clasificacion_puntualidad] || 0) + 1;
  });
  const fechas = [...porFechaEstado.keys()].sort();
  const estados = ["Puntual", "Tardanza Leve", "Tardanza Grave", "Sin Entrada"];
  const colores = { Puntual: "#3C8F63", "Tardanza Leve": "#C98A2B", "Tardanza Grave": "#B23B32", "Sin Entrada": "#8A8F98" };

  const ctx = document.getElementById("chartEvolucion");
  charts.evolucion = new Chart(ctx, {
    type: "line",
    data: {
      labels: fechas,
      datasets: estados.map((est) => ({
        label: est,
        data: fechas.map((f) => (porFechaEstado.get(f)[est] || 0)),
        borderColor: colores[est],
        backgroundColor: colores[est],
        tension: 0.25,
        pointRadius: 2,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { family: FUENTE_UI, size: 10 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { font: { family: "IBM Plex Mono", size: 9 } }, grid: { display: false } },
        y: { ticks: { font: { family: FUENTE_UI, size: 11 } }, grid: { color: "#E7E5DC" } },
      },
    },
  });
}

function renderDistribucion(df) {
  destruirChart("distribucion");
  const totalPdv = df.reduce((acc, r) => acc + (r.minutos_pdv || 0), 0);
  const totalTraslado = df.reduce((acc, r) => acc + (r.minutos_traslado || 0), 0);
  const totalDescanso = df.reduce((acc, r) => acc + (r.minutos_descanso_total || 0), 0);

  const ctx = document.getElementById("chartDistribucion");
  charts.distribucion = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["PDV", "Traslado", "Descanso"],
      datasets: [{ data: [totalPdv, totalTraslado, totalDescanso], backgroundColor: ["#171B22", "#E1962E", "#B7B2A3"] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { family: FUENTE_UI, size: 11 }, boxWidth: 10 } } },
    },
  });
}

async function renderTendencia() {
  destruirChart("tendencia");
  const ctx = document.getElementById("chartTendencia");
  const wrap = ctx.closest(".chart-panel");
  if (periodosDisponibles.length < 2) {
    wrap.querySelector(".chart-empty")?.classList.remove("hidden");
    ctx.classList.add("hidden");
    return;
  }
  wrap.querySelector(".chart-empty")?.classList.add("hidden");
  ctx.classList.remove("hidden");

  const todosPeriodos = periodosDisponibles.map((p) => p.periodo);
  const dfHist = await obtenerResumenDf(todosPeriodos);
  const porPeriodo = new Map();
  dfHist.forEach((r) => {
    if (!porPeriodo.has(r.periodo)) porPeriodo.set(r.periodo, { total: 0, puntuales: 0, tardanzas: 0 });
    const acc = porPeriodo.get(r.periodo);
    acc.total += 1;
    if (r.clasificacion_puntualidad === "Puntual") acc.puntuales += 1;
    if (["Tardanza Leve", "Tardanza Grave"].includes(r.clasificacion_puntualidad)) acc.tardanzas += 1;
  });
  const periodosOrdenados = [...porPeriodo.keys()].sort();

  charts.tendencia = new Chart(ctx, {
    data: {
      labels: periodosOrdenados,
      datasets: [
        {
          type: "line",
          label: "% Puntualidad",
          data: periodosOrdenados.map((p) => ((porPeriodo.get(p).puntuales / porPeriodo.get(p).total) * 100).toFixed(1)),
          borderColor: "#171B22",
          backgroundColor: "#171B22",
          yAxisID: "y",
        },
        {
          type: "bar",
          label: "Tardanzas",
          data: periodosOrdenados.map((p) => porPeriodo.get(p).tardanzas),
          backgroundColor: "rgba(225,150,46,0.55)",
          yAxisID: "y1",
          barThickness: 18,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { font: { family: FUENTE_UI, size: 10 }, boxWidth: 10 } } },
      scales: {
        x: { ticks: { font: { family: "IBM Plex Mono", size: 10 } }, grid: { display: false } },
        y: { type: "linear", position: "left", ticks: { font: { family: FUENTE_UI, size: 10 } }, grid: { color: "#E7E5DC" } },
        y1: { type: "linear", position: "right", ticks: { font: { family: FUENTE_UI, size: 10 } }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// TABLA DE AUDITORÍA (con tira de ruta como firma visual)
// ---------------------------------------------------------------------------
function tagEstado(r) {
  if (r.tiene_marcacion_abierta) return `<span class="tag tag-rojo">● Abierta</span>`;
  const map = {
    "Tardanza Grave": "tag-rojo",
    "Tardanza Leve": "tag-ambar",
    "Sin Entrada": "tag-gris",
    "Puntual": "tag-verde",
  };
  const clase = map[r.clasificacion_puntualidad] || "tag-gris";
  return `<span class="tag ${clase}">● ${r.clasificacion_puntualidad}</span>`;
}

function tiraDeRuta(r) {
  const secuencia = r.pdvs_secuencia && r.pdvs_secuencia.length ? r.pdvs_secuencia : (r.lista_pdvs ? r.lista_pdvs.split("; ") : []);
  if (!secuencia.length) return `<span class="muted">—</span>`;
  const puntos = secuencia
    .map(
      (pdv, i) =>
        `<span class="ruta-punto" title="${pdv}"></span>${i < secuencia.length - 1 ? '<span class="ruta-linea"></span>' : ""}`
    )
    .join("");
  return `<div class="ruta-strip">${puntos}<span class="ruta-count">${secuencia.length}</span></div>`;
}

function renderTabla(df) {
  const tbody = document.querySelector("#tablaAuditoria tbody");
  const filasOrdenadas = [...df].sort((a, b) => (a.fecha + a.nombre).localeCompare(b.fecha + b.nombre));
  tbody.innerHTML = filasOrdenadas
    .map(
      (r) => `
    <tr class="${r.alerta_exceso_descanso ? "fila-exceso" : ""}">
      <td class="td-nombre">${r.nombre}</td>
      <td class="mono">${r.fecha}</td>
      <td class="mono">${r.primer_checkin || "–"}</td>
      <td class="mono">${r.ultimo_checkout || (r.tiene_marcacion_abierta ? "Abierta" : "–")}</td>
      <td>${tagEstado(r)}</td>
      <td class="mono num">${r.minutos_tardanza}</td>
      <td class="mono num">${r.minutos_descanso_total}${r.alerta_exceso_descanso ? ` <span class="exceso">+${r.minutos_exceso_descanso}</span>` : ""}</td>
      <td class="mono num">${r.pdvs_unicos_visitados}</td>
      <td>${tiraDeRuta(r)}</td>
    </tr>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// EXPORTACIÓN
// ---------------------------------------------------------------------------
document.getElementById("exportExcelBtn").addEventListener("click", async () => {
  const periodos = obtenerPeriodosSeleccionados();
  const periodo = periodos[0] || (periodosDisponibles[0] && periodosDisponibles[0].periodo);
  if (!periodo) return;
  const resumenes = await obtenerResumenDf([periodo]);
  const marcaciones = await obtenerMarcacionesDf(periodo);
  exportarExcelConsolidado(resumenes, marcaciones, periodo);
});

document.getElementById("exportPdfBtn").addEventListener("click", () => {
  const fecha = document.getElementById("fechaPdf").value;
  if (!fecha) return;
  const registrosDelDia = cacheResumen.filter((r) => r.fecha === fecha);
  exportarPdfResumenDiario(registrosDelDia, fecha);
});

// ---------------------------------------------------------------------------
// ARRANQUE
// ---------------------------------------------------------------------------
async function arrancarApp() {
  actualizarReloj();
  await asegurarConfiguracionInicial();
  await poblarPanelConfiguracion();
  await refrescarPeriodosYVista();
}

arrancarApp();
