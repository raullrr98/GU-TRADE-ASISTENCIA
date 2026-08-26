// ============================================================================
// app.js — Orquestador principal, 100% local (sin backend, sin Supabase).
// Todo el procesamiento y almacenamiento ocurre en este navegador (IndexedDB).
//
// Todas las tarjetas, gráficos, tabla, filtros y exportaciones consumen la
// MISMA fuente de datos (cacheResumen / dfFiltradoActual) y la MISMA función
// central de clasificación (clasificarPuntualidad, en businessLogic.js), así
// que es estructuralmente imposible que un componente muestre un estado
// distinto a otro.
// ============================================================================

let charts = { ranking: null, minutosTardanza: null };
let cacheResumen = []; // dataset completo del/los período(s) seleccionados, SIN filtros de UI
let dfFiltradoActual = []; // último resultado tras aplicar filtros de UI (usado también por exportación)
let periodosDisponibles = [];
let msEmpleado, msEstado, msPdv; // instancias del multiselect propio (ver más abajo)
let filtroCategoriaInconsistencia = null; // categoría activa al hacer clic en un chip de "Atención requerida"
let paginaActual = 1;
let filasPorPagina = 15;
let ultimoDfTabla = []; // último dataset ya filtrado que alimenta la tabla (para paginar sin recalcular)

const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function nombreMes(periodoYYYYMM) {
  const [y, m] = periodoYYYYMM.split("-");
  return `${MESES_ES[parseInt(m, 10) - 1]} ${y}`;
}
function fechaLegible(fechaISO) {
  if (!fechaISO) return "—";
  const [y, m, d] = fechaISO.split("-");
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------
// RELOJ DEL ENCABEZADO
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
// SIDEBAR DESPLEGABLE (pantallas pequeñas)
// ---------------------------------------------------------------------------
document.getElementById("sidebarToggleBtn").addEventListener("click", () => {
  const abierto = document.getElementById("sidebar").classList.toggle("abierto");
  document.getElementById("sidebarToggleBtn").setAttribute("aria-expanded", String(abierto));
});

// El gráfico "Minutos de tardanza por colaborador" vive dentro de un <details>
// colapsable. Chart.js no puede calcular el tamaño correcto de un <canvas>
// que está oculto (display:none) al momento de crearse, así que se le pide
// que recalcule su tamaño justo cuando la sección se abre.
document.querySelector(".detalle-tardanzas")?.addEventListener("toggle", (e) => {
  if (e.target.open && charts.minutosTardanza) {
    charts.minutosTardanza.resize();
  }
});

// ---------------------------------------------------------------------------
// COMPONENTE: multiselect propio (reemplaza el <select multiple> nativo,
// cuyo texto de resumen ("0 elementos seleccionados") varía de forma
// inconsistente entre navegadores y no se puede personalizar de forma fiable).
// ---------------------------------------------------------------------------
function crearMultiSelect(rootId, etiquetaTodos) {
  const root = document.getElementById(rootId);
  const btn = root.querySelector(".multiselect-btn");
  const panel = root.querySelector(".multiselect-panel");
  let opciones = [];
  let seleccionados = new Set();
  let onChangeCb = null;

  function actualizarBoton() {
    if (seleccionados.size === 0) btn.textContent = etiquetaTodos;
    else if (seleccionados.size === 1) btn.textContent = [...seleccionados][0];
    else btn.textContent = `${seleccionados.size} seleccionados`;
    btn.classList.toggle("has-selection", seleccionados.size > 0);
  }

  function render() {
    if (!opciones.length) {
      panel.innerHTML = `<div class="ms-empty muted">Sin opciones para este período</div>`;
      return;
    }
    panel.innerHTML = opciones
      .map(
        (op) => `
      <label class="ms-option">
        <input type="checkbox" value="${op.replace(/"/g, "&quot;")}" ${seleccionados.has(op) ? "checked" : ""} />
        <span>${op}</span>
      </label>`
      )
      .join("");
  }

  panel.addEventListener("change", (e) => {
    if (e.target.tagName !== "INPUT") return;
    if (e.target.checked) seleccionados.add(e.target.value);
    else seleccionados.delete(e.target.value);
    actualizarBoton();
    if (onChangeCb) onChangeCb();
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".multiselect-panel").forEach((p) => {
      if (p !== panel) p.classList.add("hidden");
    });
    panel.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) panel.classList.add("hidden");
  });

  return {
    setOpciones(nuevas) {
      const nuevasSet = new Set(nuevas);
      seleccionados = new Set([...seleccionados].filter((v) => nuevasSet.has(v)));
      opciones = nuevas;
      render();
      actualizarBoton();
    },
    getSeleccionados() {
      return [...seleccionados];
    },
    limpiar() {
      seleccionados = new Set();
      render();
      actualizarBoton();
    },
    onChange(cb) {
      onChangeCb = cb;
    },
  };
}

// ---------------------------------------------------------------------------
// CONFIGURACIÓN DE NEGOCIO
// ---------------------------------------------------------------------------
async function cargarConfiguracion() {
  const filas = await dbGetAll("configuracion");
  const cfg = {};
  filas.forEach((row) => (cfg[row.clave] = row.valor));
  return {
    horaEntradaTeorica: cfg.hora_entrada_teorica || "08:00",
    horasJornadaEsperada: parseFloat(cfg.horas_jornada_esperada || "8"),
    toleranciaMin: parseInt(cfg.tolerancia_min || "10", 10),
    tardanzaLeveMaxMin: parseInt(cfg.tardanza_leve_max_min || "29", 10),
    descansoPermitidoMin: parseInt(cfg.descanso_permitido_min || "60", 10),
  };
}

async function poblarPanelConfiguracion() {
  const cfg = await cargarConfiguracion();
  document.getElementById("cfgHoraEntrada").value = cfg.horaEntradaTeorica;
  document.getElementById("cfgHorasJornada").value = cfg.horasJornadaEsperada;
  document.getElementById("cfgTolerancia").value = cfg.toleranciaMin;
  document.getElementById("cfgTardanzaLeve").value = cfg.tardanzaLeveMaxMin;
  document.getElementById("cfgDescanso").value = cfg.descansoPermitidoMin;
}

document.getElementById("guardarCfgBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("cfgStatus");
  statusEl.textContent = "Guardando y recalculando...";
  statusEl.className = "status-msg";
  const dashboardYaVisible = !document.getElementById("dashboardContent").classList.contains("hidden");
  try {
    await dbPutMany("configuracion", [
      { clave: "hora_entrada_teorica", valor: document.getElementById("cfgHoraEntrada").value.trim() },
      { clave: "horas_jornada_esperada", valor: document.getElementById("cfgHorasJornada").value },
      { clave: "tolerancia_min", valor: document.getElementById("cfgTolerancia").value },
      { clave: "tardanza_leve_max_min", valor: document.getElementById("cfgTardanzaLeve").value },
      { clave: "descanso_permitido_min", valor: document.getElementById("cfgDescanso").value },
    ]);
    await recalcularTodoElHistorico();
    const cfg = await cargarConfiguracion();
    limiteDescansoActual = cfg.descansoPermitidoMin;
    statusEl.textContent = "Configuración guardada y datos recalculados.";
    statusEl.classList.add("ok");
    // Solo se vuelve a mostrar el dashboard si YA estaba visible antes de
    // guardar; si estaba oculto (aún no se pidió ver el historial), se
    // recalcula igual en segundo plano pero se mantiene oculto.
    if (dashboardYaVisible) {
      await refrescarPeriodosYVista();
    } else {
      await refrescarListaDePeriodos();
    }
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  }
});

async function obtenerNombresPorIdEmpleado() {
  const empleados = await dbGetAll("empleados");
  return new Map(empleados.map((e) => [e.id_empleado, e.nombre]));
}

async function recalcularTodoElHistorico() {
  const periodos = await dbGetAll("periodos_cargados");
  const config = await cargarConfiguracion();
  const asignaciones = await dbGetAll("rutas_asignadas");
  const nombresPorId = await obtenerNombresPorIdEmpleado();
  for (const { periodo } of periodos) {
    const marcaciones = await dbGetByIndex("marcaciones_detalle", "periodo", periodo);
    const resumenes = calcularResumen(marcaciones, config);
    evaluarCumplimientoRuta(resumenes, asignaciones, nombresPorId);
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
let archivoSeleccionadoOnboarding = null;

document.getElementById("fileInput").addEventListener("change", (e) => {
  archivoSeleccionado = e.target.files[0] || null;
  document.getElementById("procesarBtn").disabled = !archivoSeleccionado;
  document.getElementById("uploadResumen").classList.add("hidden");
});

document.getElementById("fileInputOnboarding").addEventListener("change", (e) => {
  archivoSeleccionadoOnboarding = e.target.files[0] || null;
  document.getElementById("procesarBtnOnboarding").disabled = !archivoSeleccionadoOnboarding;
  document.getElementById("uploadResumenOnboarding").classList.add("hidden");
});

document.getElementById("procesarBtn").addEventListener("click", () =>
  procesarExcelCompartido(archivoSeleccionado, {
    periodoManualId: "periodoManual",
    statusId: "uploadStatus",
    spinnerId: "uploadSpinner",
    resumenId: "uploadResumen",
  })
);

document.getElementById("procesarBtnOnboarding").addEventListener("click", () =>
  procesarExcelCompartido(archivoSeleccionadoOnboarding, {
    periodoManualId: "periodoManualOnboarding",
    statusId: "uploadStatusOnboarding",
    spinnerId: "uploadSpinnerOnboarding",
    resumenId: "uploadResumenOnboarding",
  })
);

// Lógica de procesamiento del Excel de marcaciones, compartida entre el
// panel lateral "01 — Cargar datos" y la pantalla de bienvenida (paso
// obligatorio al entrar). Ambos llaman a esta misma función — nunca hay una
// segunda copia de las reglas de negocio, solo cambian los elementos de UI
// que se actualizan.
async function procesarExcelCompartido(archivo, ui) {
  if (!archivo) return;
  const statusEl = document.getElementById(ui.statusId);
  const spinnerEl = document.getElementById(ui.spinnerId);
  const resumenEl = document.getElementById(ui.resumenId);
  statusEl.textContent = "Leyendo y procesando archivo...";
  statusEl.className = "status-msg";
  spinnerEl.classList.remove("hidden");
  resumenEl.classList.add("hidden");

  try {
    const arrayBuffer = await archivo.arrayBuffer();
    const { filas, meta } = leerYLimpiarExcel(arrayBuffer);
    if (!filas.length) {
      throw new Error(
        meta.filasTotalesHoja === 0
          ? "El archivo está vacío o la hoja no contiene filas."
          : "No se encontraron filas válidas (revisa fechas y columnas obligatorias)."
      );
    }

    const periodoManual = document.getElementById(ui.periodoManualId).value.trim();
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
      id_punto_venta: f.id_punto_venta,
      actividad: f.actividad,
      hora_inicio: f.hora_inicio,
      hora_salida: f.hora_salida,
      tiempo_transcurrido_min: f.tiempo_transcurrido_min,
      marcacion_abierta: f.marcacion_abierta,
      periodo: f.periodo,
    }));
    await dbPutMany("marcaciones_detalle", marcacionesInsert);

    // 3) Calcular reglas de negocio (antes de guardar el período, para poder
    //    registrar si hubo advertencias reales en el historial de procesos)
    const config = await cargarConfiguracion();
    const resumenes = calcularResumen(filas, config);

    // 3a) Si está activada la sincronización automática, intentar traer la
    //     versión más reciente del catálogo de rutas ANTES de evaluar
    //     cumplimiento (best-effort: si falla — sin internet, hoja no
    //     publicada, etc. — se sigue con lo que ya haya guardado localmente).
    const cfgSync = await dbGetAll("configuracion");
    const autoSyncActivo = cfgSync.find((c) => c.clave === "rutas_auto_sync")?.valor === "1";
    if (autoSyncActivo) {
      await sincronizarRutasCompartido(true, { urlId: "rutasSheetUrl", statusId: "rutasSyncStatus", infoId: "rutasSyncInfo", resumenId: "rutasResumen" });
    }

    // 3b) Aplicar cumplimiento de ruta asignada, si hay un catálogo cargado
    const nombresPorId = new Map(empleadosUnicos.map((e) => [e.id_empleado, e.nombre]));
    const asignacionesRuta = await dbGetAll("rutas_asignadas");
    evaluarCumplimientoRuta(resumenes, asignacionesRuta, nombresPorId);

    const inconsistenciasResumen = resumenes.filter((r) => r.tiene_inconsistencia).length;
    const inconsistenciasTotal =
      inconsistenciasResumen + meta.fechasInvalidas + meta.horasInvalidas + meta.duplicadosDetectados;
    const advertencias = [];
    if (meta.fechasInvalidas > 0) advertencias.push(`${meta.fechasInvalidas} fila(s) con fecha inválida (descartadas)`);
    if (meta.horasInvalidas > 0) advertencias.push(`${meta.horasInvalidas} fila(s) con hora no interpretable`);
    if (meta.duplicadosDetectados > 0) advertencias.push(`${meta.duplicadosDetectados} registro(s) duplicado(s) detectado(s)`);
    if (meta.filasDescartadas > 0) advertencias.push(`${meta.filasDescartadas} fila(s) descartadas por datos incompletos`);
    if (meta.columnasOpcionalesNoDetectadas && meta.columnasOpcionalesNoDetectadas.length) {
      advertencias.push(
        `No se detectó la columna "${meta.columnasOpcionalesNoDetectadas.join('", "')}" — esos datos quedarán vacíos o en 0`
      );
    }

    // 4) Registrar el periodo cargado (con dato real de advertencias, para el
    //    historial de procesos en la barra lateral)
    await dbPut("periodos_cargados", {
      periodo,
      nombre_archivo_original: archivo.name,
      filas_procesadas: marcacionesInsert.length,
      empleados_afectados: empleadosUnicos.length,
      fecha_carga: new Date().toISOString(),
      inconsistencias_total: inconsistenciasTotal,
      tiene_advertencias: advertencias.length > 0 || inconsistenciasTotal > 0,
    });

    // 5) Guardar resumen diario ya calculado
    await guardarResumenes(periodo, resumenes);

    // 6) Resumen de carga para el usuario
    const fechas = filas.map((f) => f.fecha).sort();

    statusEl.textContent = `Carga exitosa: ${periodo}.`;
    statusEl.classList.add("ok");

    resumenEl.classList.remove("hidden");
    resumenEl.innerHTML = `
      <div class="ur-item"><span>Archivo</span><strong>${archivo.name}</strong></div>
      <div class="ur-item"><span>Filas procesadas</span><strong>${filas.length}</strong></div>
      <div class="ur-item"><span>Colaboradores detectados</span><strong>${empleadosUnicos.length}</strong></div>
      <div class="ur-item"><span>Fecha inicial</span><strong>${fechaLegible(fechas[0])}</strong></div>
      <div class="ur-item"><span>Fecha final</span><strong>${fechaLegible(fechas[fechas.length - 1])}</strong></div>
      <div class="ur-item"><span>Registros válidos</span><strong>${meta.filasValidas} / ${meta.filasTotalesHoja}</strong></div>
      <div class="ur-item"><span>Inconsistencias detectadas</span><strong>${inconsistenciasTotal}</strong></div>
      ${advertencias.length ? `<div class="ur-warn">⚠ ${advertencias.join(" · ")}</div>` : ""}
    `;

    // Refresca la lista de períodos y el historial, pero NO muestra el
    // dashboard automáticamente — eso solo pasa al pulsar "Siguiente" en la
    // pantalla de bienvenida (paso obligatorio, confirmado con el usuario).
    await refrescarListaDePeriodos();
    limpiarAvisoOnboarding();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  } finally {
    spinnerEl.classList.add("hidden");
  }
}

async function guardarResumenes(periodo, resumenes) {
  await dbDeleteByIndex("asistencia_resumen_diario", "periodo", periodo);
  await dbPutMany("asistencia_resumen_diario", resumenes);
}

// ---------------------------------------------------------------------------
// INGESTA DEL CATÁLOGO DE RUTAS ASIGNADAS (archivo aparte, no cambia mes a mes)
// ---------------------------------------------------------------------------
let archivoRutasSeleccionado = null;
let archivoRutasSeleccionadoOnboarding = null;

document.getElementById("fileInputRutas").addEventListener("change", (e) => {
  archivoRutasSeleccionado = e.target.files[0] || null;
  document.getElementById("procesarRutasBtn").disabled = !archivoRutasSeleccionado;
  document.getElementById("rutasResumen").classList.add("hidden");
});

document.getElementById("fileInputRutasOnboarding").addEventListener("change", (e) => {
  archivoRutasSeleccionadoOnboarding = e.target.files[0] || null;
  document.getElementById("procesarRutasBtnOnboarding").disabled = !archivoRutasSeleccionadoOnboarding;
  document.getElementById("rutasResumenOnboarding").classList.add("hidden");
});

document.getElementById("procesarRutasBtn").addEventListener("click", () =>
  procesarArchivoRutasCompartido(archivoRutasSeleccionado, { statusId: "rutasStatus", resumenId: "rutasResumen" })
);
document.getElementById("procesarRutasBtnOnboarding").addEventListener("click", () =>
  procesarArchivoRutasCompartido(archivoRutasSeleccionadoOnboarding, { statusId: "rutasStatusOnboarding", resumenId: "rutasResumenOnboarding" })
);

async function procesarArchivoRutasCompartido(archivo, ui) {
  if (!archivo) return;
  const statusEl = document.getElementById(ui.statusId);
  const resumenEl = document.getElementById(ui.resumenId);
  statusEl.textContent = "Leyendo archivo de rutas...";
  statusEl.className = "status-msg";
  resumenEl.classList.add("hidden");

  try {
    const arrayBuffer = await archivo.arrayBuffer();
    const { asignaciones, meta } = leerRutasAsignadas(arrayBuffer);
    await guardarAsignacionesYRecalcular(asignaciones, meta, archivo.name, resumenEl);
    statusEl.textContent = "Rutas cargadas correctamente.";
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  }
}

// Lógica compartida entre "cargar archivo manual" y "sincronizar en vivo":
// guarda el catálogo de rutas en IndexedDB y recalcula todo el histórico.
async function guardarAsignacionesYRecalcular(asignaciones, meta, nombreOrigen, resumenEl) {
  if (!asignaciones.length) {
    throw new Error("No se encontraron filas válidas (revisa las columnas de Persona y Punto de venta).");
  }

  await dbClearStore("rutas_asignadas");
  await dbPutMany("rutas_asignadas", asignaciones);

  const personasConDia = new Set(asignaciones.filter((a) => a.dias.length).map((a) => a.nombre_normalizado)).size;

  if (resumenEl) {
    resumenEl.classList.remove("hidden");
    resumenEl.innerHTML = `
      <div class="ur-item"><span>Origen</span><strong>${nombreOrigen}</strong></div>
      <div class="ur-item"><span>Filas procesadas</span><strong>${meta.filasValidas} / ${meta.filasTotalesHoja}</strong></div>
      <div class="ur-item"><span>Personas con ruta por día</span><strong>${personasConDia}</strong></div>
      <div class="ur-item"><span>Filas sin día (no se evalúan)</span><strong>${meta.filasSinDia}</strong></div>
    `;
  }

  actualizarChipEstadoRutas();

  // Recalcular todo el histórico ya cargado con el nuevo catálogo de rutas
  await recalcularTodoElHistorico();
  const dashboardYaVisible = !document.getElementById("dashboardContent").classList.contains("hidden");
  if (dashboardYaVisible) await refrescarPeriodosYVista();
}

// ---------------------------------------------------------------------------
// SINCRONIZACIÓN EN VIVO CON GOOGLE SHEETS
// ---------------------------------------------------------------------------
// La URL debe ser el enlace de exportación CSV de una hoja PUBLICADA de
// Google Sheets (Archivo → Compartir → Publicar en la web → elegir la hoja
// específica → formato CSV → copiar enlace). Google sirve ese endpoint con
// cabeceras CORS abiertas, así que se puede leer directo desde el navegador
// sin backend propio.

// Guarda la URL en config y mantiene sincronizados los DOS campos donde
// puede vivir (barra lateral y pantalla de bienvenida) — cambiar cualquiera
// de los dos actualiza el mismo valor guardado.
async function guardarUrlRutas(valor) {
  await dbPutMany("configuracion", [{ clave: "rutas_sheet_url", valor: valor.trim() }]);
  document.getElementById("rutasSheetUrl").value = valor.trim();
  document.getElementById("rutasSheetUrlOnboarding").value = valor.trim();
  actualizarChipEstadoRutas();
}
document.getElementById("rutasSheetUrl").addEventListener("change", (e) => guardarUrlRutas(e.target.value));
document.getElementById("rutasSheetUrlOnboarding").addEventListener("change", (e) => guardarUrlRutas(e.target.value));

async function guardarAutoSyncRutas(activo) {
  await dbPutMany("configuracion", [{ clave: "rutas_auto_sync", valor: activo ? "1" : "0" }]);
  document.getElementById("rutasAutoSync").checked = activo;
  document.getElementById("rutasAutoSyncOnboarding").checked = activo;
}
document.getElementById("rutasAutoSync").addEventListener("change", (e) => guardarAutoSyncRutas(e.target.checked));
document.getElementById("rutasAutoSyncOnboarding").addEventListener("change", (e) => guardarAutoSyncRutas(e.target.checked));

// Chip visual ("Sin configurar todavía" / "✓ Configurado") en la pantalla
// de bienvenida, reflejando datos reales de IndexedDB — nunca información
// inventada.
async function actualizarChipEstadoRutas() {
  const chip = document.getElementById("rutasEstadoOnboarding");
  if (!chip) return;
  const asignaciones = await dbGetAll("rutas_asignadas");
  if (asignaciones.length) {
    chip.textContent = `✓ Configurado — ${asignaciones.length} fila(s) de ruta`;
    chip.classList.add("configurado");
  } else {
    chip.textContent = "Sin configurar todavía";
    chip.classList.remove("configurado");
  }
}

function textoUltimaSync(fechaISO) {
  const fecha = new Date(fechaISO);
  return `Última sincronización: ${fecha.toLocaleDateString("es-ES")} ${fecha.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
}

async function poblarPanelSincronizacionRutas() {
  const filas = await dbGetAll("configuracion");
  const cfg = {};
  filas.forEach((row) => (cfg[row.clave] = row.valor));
  document.getElementById("rutasSheetUrl").value = cfg.rutas_sheet_url || "";
  document.getElementById("rutasSheetUrlOnboarding").value = cfg.rutas_sheet_url || "";
  document.getElementById("rutasAutoSync").checked = cfg.rutas_auto_sync === "1";
  document.getElementById("rutasAutoSyncOnboarding").checked = cfg.rutas_auto_sync === "1";
  if (cfg.rutas_ultima_sincronizacion) {
    document.getElementById("rutasSyncInfo").textContent = textoUltimaSync(cfg.rutas_ultima_sincronizacion);
    document.getElementById("rutasSyncInfoOnboarding").textContent = textoUltimaSync(cfg.rutas_ultima_sincronizacion);
  }
  await actualizarChipEstadoRutas();
}

/**
 * Descarga la hoja de rutas publicada en Google Sheets (CSV) y actualiza el
 * catálogo local. Se usa tanto para los botones "Sincronizar ahora" (barra
 * lateral y pantalla de bienvenida) como para la sincronización automática
 * al procesar un Excel de marcaciones.
 * @param {boolean} silencioso - si es true, no interrumpe con errores
 *   visibles (usado en la sincronización automática, best-effort).
 * @param {Object} ui - { urlId, statusId, infoId, resumenId }
 */
async function sincronizarRutasCompartido(silencioso, ui) {
  const url = document.getElementById(ui.urlId).value.trim();
  if (!url) {
    if (!silencioso) throw new Error("Pegá primero el enlace de Google Sheets (CSV).");
    return false;
  }

  const statusEl = document.getElementById(ui.statusId);
  const resumenEl = document.getElementById(ui.resumenId);
  if (!silencioso) {
    statusEl.textContent = "Descargando desde Google Sheets...";
    statusEl.className = "status-msg";
  }

  try {
    const respuesta = await fetch(url, { cache: "no-store" });
    if (!respuesta.ok) {
      throw new Error(
        `Google Sheets respondió con error ${respuesta.status}. Verificá que la hoja esté publicada (Archivo → Compartir → Publicar en la web).`
      );
    }
    const textoCSV = await respuesta.text();
    const { asignaciones, meta } = leerRutasAsignadasDesdeCSV(textoCSV);
    await guardarAsignacionesYRecalcular(asignaciones, meta, "Google Sheets (sincronización en vivo)", resumenEl);

    const ahora = new Date().toISOString();
    await dbPutMany("configuracion", [{ clave: "rutas_ultima_sincronizacion", valor: ahora }]);
    document.getElementById("rutasSyncInfo").textContent = textoUltimaSync(ahora);
    document.getElementById("rutasSyncInfoOnboarding").textContent = textoUltimaSync(ahora);

    if (!silencioso) {
      statusEl.textContent = "Sincronizado correctamente.";
      statusEl.classList.add("ok");
    }
    return true;
  } catch (err) {
    // Un fetch() a un dominio que bloquea CORS falla con un TypeError
    // genérico ("Failed to fetch"), sin detalle — se aclara para que el
    // usuario sepa que probablemente falta publicar la hoja correctamente.
    const mensaje =
      err.message === "Failed to fetch"
        ? "No se pudo conectar con Google Sheets. Verificá tu conexión a internet y que la hoja esté publicada como CSV (no solo compartida)."
        : err.message;
    if (!silencioso) {
      statusEl.textContent = "Error: " + mensaje;
      statusEl.classList.add("error");
    } else {
      console.warn("Sincronización automática de rutas falló:", mensaje);
    }
    return false;
  }
}

document.getElementById("sincronizarRutasBtn").addEventListener("click", () =>
  sincronizarRutasCompartido(false, { urlId: "rutasSheetUrl", statusId: "rutasSyncStatus", infoId: "rutasSyncInfo", resumenId: "rutasResumen" })
);
document.getElementById("sincronizarRutasBtnOnboarding").addEventListener("click", () =>
  sincronizarRutasCompartido(false, { urlId: "rutasSheetUrlOnboarding", statusId: "rutasSyncStatusOnboarding", infoId: "rutasSyncInfoOnboarding", resumenId: "rutasResumenOnboarding" })
);

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
// IMPORTANTE: al abrir la pestaña, el dashboard NUNCA se muestra automático
// aunque ya existan datos guardados en este navegador. Solo aparece cuando:
//   a) se procesa un Excel con éxito, o
//   b) el usuario cambia explícitamente el período (radio / selector), o
//   c) el usuario pulsa "Ver historial guardado" en la pantalla vacía.
// Esto evita que alguien abra la pestaña y vea de entrada datos de una
// carga anterior sin haber pedido verlos.
async function refrescarListaDePeriodos() {
  await cargarPeriodosDisponibles();
  poblarSelectoresPeriodo();
  actualizarEmptyState();
  renderHistorialProcesos();
}

function actualizarEmptyState() {
  const textoEl = document.getElementById("emptyStateTexto");
  if (periodosDisponibles.length) {
    textoEl.innerHTML =
      "Ya tenés datos guardados en este navegador. Si no necesitás subir nada nuevo, pulsá <strong>Siguiente</strong> para ir directo al tablero.";
  } else {
    textoEl.innerHTML =
      "Todavía no cargaste ningún mes en este navegador. Subí tu primer Excel para continuar.";
  }
}

// ---------------------------------------------------------------------------
// HISTORIAL DE PROCESOS (barra lateral) — usa exclusivamente los períodos
// realmente guardados en IndexedDB (periodos_cargados). No hay datos de
// ejemplo/fijos: si no hay cargas, la lista queda vacía con un mensaje.
// ---------------------------------------------------------------------------
function renderHistorialProcesos() {
  const cont = document.getElementById("historialProcesos");
  if (!cont) return;
  if (!periodosDisponibles.length) {
    cont.innerHTML = `<p class="hp-vacio muted small">Sin procesos guardados todavía.</p>`;
    return;
  }
  const ordenados = [...periodosDisponibles].sort((a, b) => (a.fecha_carga < b.fecha_carga ? 1 : -1));
  cont.innerHTML = ordenados
    .slice(0, 6)
    .map((p) => {
      const fecha = p.fecha_carga ? new Date(p.fecha_carga) : null;
      const fechaTexto = fecha
        ? `${fecha.toLocaleDateString("es-ES")} ${fecha.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
        : "—";
      const conAdvertencias = !!p.tiene_advertencias;
      return `
      <button type="button" class="hp-item" data-periodo="${p.periodo}" title="Ver ${nombreMes(p.periodo)}">
        <span class="hp-dot ${conAdvertencias ? "hp-dot-amarillo" : "hp-dot-verde"}"></span>
        <span class="hp-texto">
          <span class="hp-estado">${conAdvertencias ? "Con advertencias" : "Proceso completado"}</span>
          <span class="hp-fecha mono">${fechaTexto}</span>
        </span>
        <span class="hp-flecha">›</span>
      </button>`;
    })
    .join("");

  cont.querySelectorAll(".hp-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelector('input[name="modoVista"][value="especifico"]').checked = true;
      document.getElementById("periodoSelect").classList.remove("hidden");
      document.getElementById("periodoMultiWrap").classList.add("hidden");
      document.getElementById("periodoSelect").value = btn.dataset.periodo;
      mostrarDashboard();
    });
  });
}

document.getElementById("actualizarHistorialBtn")?.addEventListener("click", refrescarListaDePeriodos);

// "Siguiente" es el paso obligatorio de la pantalla de bienvenida: si no hay
// ningún período cargado todavía, no tiene sentido pasar al tablero (no
// habría nada que ver), así que se avisa en vez de navegar en silencio.
function limpiarAvisoOnboarding() {
  const aviso = document.getElementById("onboardingAviso");
  aviso.classList.add("hidden");
  aviso.textContent = "";
}

document.getElementById("siguienteOnboardingBtn").addEventListener("click", async () => {
  if (!periodosDisponibles.length) {
    const aviso = document.getElementById("onboardingAviso");
    aviso.textContent = "Subí al menos un Excel de marcaciones antes de continuar.";
    aviso.classList.remove("hidden");
    return;
  }
  limpiarAvisoOnboarding();
  await mostrarDashboard();
});

async function refrescarPeriodosYVista(periodoAEnfocar) {
  await cargarPeriodosDisponibles();
  poblarSelectoresPeriodo();
  renderHistorialProcesos();
  if (periodoAEnfocar) document.getElementById("periodoSelect").value = periodoAEnfocar;
  await mostrarDashboard();
}

async function mostrarDashboard() {
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

async function renderizarVistaActual() {
  await mostrarDashboard();
}

function obtenerPdvsDeRegistro(r) {
  if (r.pdvs_secuencia && r.pdvs_secuencia.length) return r.pdvs_secuencia;
  if (r.lista_pdvs) return r.lista_pdvs.split("; ");
  return [];
}

function poblarFiltrosDinamicos(df) {
  const empleados = [...new Set(df.map((r) => r.nombre))].sort();
  const estados = [...new Set(df.map((r) => r.clasificacion_puntualidad))].sort();
  const pdvs = [...new Set(df.flatMap(obtenerPdvsDeRegistro))].sort();
  msEmpleado.setOpciones(empleados);
  msEstado.setOpciones(estados);
  msPdv.setOpciones(pdvs);

  if (df.length) {
    const fechas = df.map((r) => r.fecha).sort();
    if (!document.getElementById("filtroFechaDesde").value) document.getElementById("filtroFechaDesde").value = fechas[0];
    if (!document.getElementById("filtroFechaHasta").value) document.getElementById("filtroFechaHasta").value = fechas[fechas.length - 1];
    document.getElementById("fechaPdf").value = fechas[fechas.length - 1];
  }
}

document.getElementById("buscarColaboradorInput").addEventListener("input", () => {
  paginaActual = 1;
  aplicarFiltrosYRenderizar();
});

["filtroFechaDesde", "filtroFechaHasta"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => { paginaActual = 1; aplicarFiltrosYRenderizar(); });
});

document.getElementById("limpiarFiltrosBtn").addEventListener("click", () => {
  msEmpleado.limpiar();
  msEstado.limpiar();
  msPdv.limpiar();
  document.getElementById("buscarColaboradorInput").value = "";
  filtroCategoriaInconsistencia = null;
  paginaActual = 1;
  if (cacheResumen.length) {
    const fechas = cacheResumen.map((r) => r.fecha).sort();
    document.getElementById("filtroFechaDesde").value = fechas[0];
    document.getElementById("filtroFechaHasta").value = fechas[fechas.length - 1];
  }
  aplicarFiltrosYRenderizar();
});

function actualizarPeriodoAnalizadoLabel(df) {
  const el = document.getElementById("periodoAnalizadoLabel");
  const periodos = obtenerPeriodosSeleccionados();
  const periodosTexto = periodos.map(nombreMes).join(", ");
  const desde = document.getElementById("filtroFechaDesde").value;
  const hasta = document.getElementById("filtroFechaHasta").value;
  const rango = desde && hasta ? ` · ${fechaLegible(desde)} – ${fechaLegible(hasta)}` : "";
  el.textContent = `Período analizado: ${periodosTexto || "—"}${rango} · ${df.length} registro(s)`;

  const chip = document.getElementById("headerResumenChip");
  if (chip) {
    chip.textContent = periodos.length ? `${periodosTexto} · ${df.length.toLocaleString("es-ES")} registros` : "Sin datos cargados";
  }
}

// Categoriza cada mensaje de inconsistencia (generado en businessLogic.js)
// para la franja "Atención requerida". No hay una segunda regla de negocio
// acá: solo se interpretan los textos que YA produce calcularResumen().
function categorizarInconsistencia(msg) {
  if (msg.startsWith("Falta marcación de entrada")) return "sin_entrada";
  if (msg.startsWith("Falta marcación de salida")) return "sin_salida";
  if (msg.startsWith("Descanso excede")) return "descanso_excedido";
  if (msg.startsWith("Entrada posterior")) return "entrada_post_salida";
  if (msg.startsWith("Tiempo total del día superior")) return "tiempo_imposible";
  if (msg.startsWith("Ruta incompleta")) return "ruta_incompleta";
  return "otras";
}
const CATEGORIAS_ATENCION = [
  { key: "sin_entrada", label: "sin entrada" },
  { key: "sin_salida", label: "marcación abierta" },
  { key: "descanso_excedido", label: "descansos excedidos" },
  { key: "entrada_post_salida", label: "entrada posterior a la salida" },
  { key: "tiempo_imposible", label: "tiempo > 24 h" },
  { key: "ruta_incompleta", label: "rutas incompletas" },
  { key: "otras", label: "otras inconsistencias" },
];

function aplicarFiltrosYRenderizar() {
  const empSel = msEmpleado.getSeleccionados();
  const estSel = msEstado.getSeleccionados();
  const pdvSel = msPdv.getSeleccionados();
  const desde = document.getElementById("filtroFechaDesde").value;
  const hasta = document.getElementById("filtroFechaHasta").value;
  const textoBusqueda = document.getElementById("buscarColaboradorInput").value.trim().toLowerCase();

  // df: dataset con TODOS los filtros excepto la categoría de "Atención
  // requerida" — es el que alimenta KPIs, gráficos y los conteos de la
  // propia franja de atención (para que el conteo no se reduzca a sí mismo
  // al hacer clic en una categoría).
  let df = cacheResumen;
  if (empSel.length) df = df.filter((r) => empSel.includes(r.nombre));
  if (estSel.length) df = df.filter((r) => estSel.includes(r.clasificacion_puntualidad));
  if (pdvSel.length) df = df.filter((r) => obtenerPdvsDeRegistro(r).some((p) => pdvSel.includes(p)));
  if (desde) df = df.filter((r) => r.fecha >= desde);
  if (hasta) df = df.filter((r) => r.fecha <= hasta);
  if (textoBusqueda) df = df.filter((r) => (r.nombre || "").toLowerCase().includes(textoBusqueda));

  actualizarPeriodoAnalizadoLabel(df);

  const sinResultadosEl = document.getElementById("sinResultados");
  const contenidoEl = document.getElementById("contenidoFiltrado");
  if (!df.length) {
    sinResultadosEl.classList.remove("hidden");
    contenidoEl.classList.add("hidden");
    dfFiltradoActual = df;
    return;
  }
  sinResultadosEl.classList.add("hidden");
  contenidoEl.classList.remove("hidden");

  renderKPIs(df);
  renderGraficos(df);
  renderAtencionRequerida(df);

  // dfTabla: el mismo df, más la categoría de inconsistencia si hay una
  // activa (clic en un chip de "Atención requerida"). La exportación a Excel
  // usa este mismo dataset, para que Excel y tabla siempre coincidan.
  let dfTabla = df;
  if (filtroCategoriaInconsistencia) {
    dfTabla = dfTabla.filter((r) =>
      (r.inconsistencias || []).some((m) => categorizarInconsistencia(m) === filtroCategoriaInconsistencia)
    );
  }
  dfFiltradoActual = dfTabla;
  ultimoDfTabla = dfTabla;
  if (paginaActual < 1) paginaActual = 1;
  renderTabla(dfTabla);
}

function renderAtencionRequerida(df) {
  const cont = document.getElementById("atencionRequerida");
  if (!cont) return;
  const conteoPorCategoria = {};
  CATEGORIAS_ATENCION.forEach((c) => (conteoPorCategoria[c.key] = 0));
  let totalUnico = 0;
  df.forEach((r) => {
    if (!r.tiene_inconsistencia) return;
    totalUnico += 1;
    const categoriasDeEstaFila = new Set((r.inconsistencias || []).map(categorizarInconsistencia));
    categoriasDeEstaFila.forEach((cat) => {
      conteoPorCategoria[cat] = (conteoPorCategoria[cat] || 0) + 1;
    });
  });

  if (totalUnico === 0) {
    cont.className = "atencion-requerida atencion-ok";
    cont.innerHTML = `<span class="atencion-check" aria-hidden="true">✓</span> Sin casos críticos en el período analizado`;
    filtroCategoriaInconsistencia = null;
    return;
  }

  cont.className = "atencion-requerida atencion-alerta";
  const chips = CATEGORIAS_ATENCION.filter((c) => conteoPorCategoria[c.key] > 0)
    .map(
      (c) => `
      <button type="button" class="atencion-chip${filtroCategoriaInconsistencia === c.key ? " activo" : ""}" data-cat="${c.key}">
        <strong>${conteoPorCategoria[c.key]}</strong> ${c.label}
      </button>`
    )
    .join("");

  cont.innerHTML = `
    <div class="atencion-titulo"><span aria-hidden="true">⚠</span> ATENCIÓN REQUERIDA <span class="atencion-total">· ${totalUnico} caso(s)</span></div>
    <div class="atencion-chips">
      ${chips}
      ${filtroCategoriaInconsistencia ? `<button type="button" class="atencion-chip atencion-quitar" id="atencionQuitarFiltro">Quitar filtro ✕</button>` : ""}
    </div>
  `;

  cont.querySelectorAll(".atencion-chip[data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      filtroCategoriaInconsistencia = filtroCategoriaInconsistencia === cat ? null : cat;
      paginaActual = 1;
      aplicarFiltrosYRenderizar();
      const toolbarEl = document.getElementById("auditoriaToolbar");
      if (toolbarEl && typeof toolbarEl.scrollIntoView === "function") {
        toolbarEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
  const btnQuitar = document.getElementById("atencionQuitarFiltro");
  if (btnQuitar) {
    btnQuitar.addEventListener("click", () => {
      filtroCategoriaInconsistencia = null;
      aplicarFiltrosYRenderizar();
    });
  }
}

// ---------------------------------------------------------------------------
// KPIs — cada tarjeta separa claramente cantidad / minutos / porcentaje
// ---------------------------------------------------------------------------
function renderKPIs(df) {
  const totalColaboradores = new Set(df.map((r) => r.id_empleado)).size;
  const totalDias = df.length;
  const puntuales = df.filter((r) => r.clasificacion_puntualidad === ESTADOS.PUNTUAL).length;
  const pctPuntualidad = totalDias ? ((puntuales / totalDias) * 100).toFixed(1) : "0.0";

  const filasTardanza = df.filter((r) => esTardanza(r.clasificacion_puntualidad));
  const cantidadTardanzas = filasTardanza.length;

  const filasConHoras = df.filter((r) => r.minutos_efectivos !== null && r.minutos_efectivos !== undefined);
  const promMinutosEfectivos = filasConHoras.length
    ? filasConHoras.reduce((acc, r) => acc + r.minutos_efectivos, 0) / filasConHoras.length
    : null;
  const cantidadJornadaIncompleta = filasConHoras.filter((r) => !r.cumplio_jornada).length;

  const ICONOS = {
    personas: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.8 14.2c2.8.4 5.2 2.4 5.2 5.8"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9.2"/><path d="m8 12.5 2.6 2.6L16.5 9"/></svg>',
    alerta: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9.2"/><path d="M12 7v6"/><circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none"/></svg>',
    reloj: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9.2"/><path d="M12 7v5.2l3.6 2.1"/></svg>',
    salida: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4H5v16h5"/><path d="M14 8l5 4-5 4"/><path d="M19 12H9"/></svg>',
  };

  const cfg2 = document.getElementById("cfgHorasJornada")?.value || "8";

  const kpis = [
    {
      titulo: "Colaboradores",
      valor: totalColaboradores,
      unidad: "",
      icono: ICONOS.personas,
      claseIcono: "kpi-icono-neutro",
      desc: "Colaboradores distintos en el período filtrado.",
      tooltip: "Cantidad de colaboradores diferentes con al menos un registro dentro de los filtros aplicados.",
    },
    {
      titulo: "Puntualidad",
      valor: `${pctPuntualidad}%`,
      unidad: "",
      icono: ICONOS.check,
      claseIcono: "kpi-icono-verde",
      desc: "Entradas hasta las 08:10.",
      tooltip: "Porcentaje de entradas registradas hasta las 08:10 inclusive, considerando los filtros aplicados. Es un porcentaje, no una cantidad.",
    },
    {
      titulo: "Cantidad de tardanzas",
      valor: cantidadTardanzas,
      unidad: "eventos",
      icono: ICONOS.alerta,
      claseIcono: "kpi-icono-rojo",
      desc: "Llegadas desde las 08:11.",
      tooltip: "Número de entradas registradas desde las 08:11 (Tardanza Leve o Tardanza a Supervisar). No representa minutos, representa eventos.",
    },
    {
      titulo: "Horas efectivas",
      valor: promMinutosEfectivos === null ? "—" : formatHorasTrabajadas(promMinutosEfectivos),
      unidad: promMinutosEfectivos === null ? "" : "promedio/día",
      icono: ICONOS.reloj,
      claseIcono: "kpi-icono-ambar",
      desc: `Entrada a salida, sin contar el descanso. Jornada obligatoria: ${cfg2} h.`,
      tooltip: "Promedio de horas efectivas trabajadas por día: diferencia entre el primer check-in y el último check-out, descontando el descanso. Solo considera días con entrada y salida completas (sin marcación abierta).",
    },
    {
      titulo: "Jornada incompleta",
      valor: cantidadJornadaIncompleta,
      unidad: "días",
      icono: ICONOS.salida,
      claseIcono: cantidadJornadaIncompleta > 0 ? "kpi-icono-rojo" : "kpi-icono-verde",
      desc: `Días con menos de ${cfg2} h efectivas trabajadas.`,
      tooltip: "Cantidad de días en los que las horas efectivas trabajadas (entrada a salida, sin contar el descanso) fueron menores a la jornada obligatoria configurada.",
    },
  ];

  const row = document.getElementById("kpiRow");
  row.innerHTML = kpis
    .map(
      (k) => `
    <div class="kpi-stub">
      <div class="kpi-top">
        <div class="kpi-label">${k.titulo}</div>
        <span class="kpi-icono ${k.claseIcono}" aria-hidden="true">${k.icono}</span>
      </div>
      <div class="kpi-value${String(k.valor).length > 8 ? " valor-largo" : ""}">${k.valor}${k.unidad ? ` <span class="kpi-unidad">${k.unidad}</span>` : ""}</div>
      <div class="kpi-desc">${k.desc} <span class="info-icon" title="${k.tooltip}">ⓘ</span></div>
    </div>`
    )
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
  renderMinutosTardanza(df);
}

const FUENTE_UI = "Arial, sans-serif";
const FUENTE_MONO = "Arial, sans-serif";

// Plugin propio (sin dependencias externas) para dibujar el valor al final
// de cada barra horizontal — evita depender de chartjs-plugin-datalabels.
const pluginValorAlFinal = {
  id: "valorAlFinal",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      meta.data.forEach((bar, i) => {
        const valor = dataset.data[i];
        if (valor === undefined || valor === null) return;
        ctx.save();
        ctx.font = "600 11px " + FUENTE_MONO;
        ctx.fillStyle = "#0E1A2E";
        ctx.textBaseline = "middle";
        if (chart.options.indexAxis === "y") {
          ctx.textAlign = "left";
          ctx.fillText(String(valor), bar.x + 6, bar.y);
        } else {
          ctx.textAlign = "center";
          ctx.fillText(String(valor), bar.x, bar.y - 8);
        }
        ctx.restore();
      });
    });
  },
};

function renderRanking(df) {
  destruirChart("ranking");
  const stats = new Map(); // nombre -> {total, leve, supervisar, minutos}
  df.filter((r) => esTardanza(r.clasificacion_puntualidad)).forEach((r) => {
    if (!stats.has(r.nombre)) stats.set(r.nombre, { total: 0, leve: 0, supervisar: 0, minutos: 0 });
    const s = stats.get(r.nombre);
    s.total += 1;
    if (r.clasificacion_puntualidad === ESTADOS.LEVE) s.leve += 1;
    if (r.clasificacion_puntualidad === ESTADOS.SUPERVISAR) s.supervisar += 1;
    s.minutos += r.minutos_tardanza || 0;
  });
  const entradas = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
  const ctx = document.getElementById("chartRanking");
  const alturaPorBarra = 28;
  ctx.parentElement.style.height = `${Math.max(220, entradas.length * alturaPorBarra + 60)}px`;

  charts.ranking = new Chart(ctx, {
    type: "bar",
    data: {
      labels: entradas.map((e) => e[0]),
      datasets: [{ label: "Cantidad de tardanzas", data: entradas.map((e) => e[1].total), backgroundColor: "#D24B4B", borderRadius: 2, barThickness: 16 }],
    },
    plugins: [pluginValorAlFinal],
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 24 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const s = entradas[item.dataIndex][1];
              return [
                `Cantidad de tardanzas: ${s.total}`,
                `  Tardanza leve: ${s.leve}`,
                `  Tardanza a supervisar: ${s.supervisar}`,
                `Minutos acumulados: ${formatMinutos(s.minutos, { conEquivalencia: true })}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Cantidad de tardanzas (número de eventos)", font: { family: FUENTE_UI, size: 10 } },
          ticks: { font: { family: FUENTE_UI, size: 11 }, precision: 0, stepSize: 1 },
          grid: { color: "#E4E6EC" },
        },
        y: { ticks: { font: { family: FUENTE_UI, size: 11 }, autoSkip: false }, grid: { display: false } },
      },
    },
  });
}

function renderMinutosTardanza(df) {
  destruirChart("minutosTardanza");
  const stats = new Map(); // nombre -> {minutos, cantidad}
  df.filter((r) => esTardanza(r.clasificacion_puntualidad)).forEach((r) => {
    if (!stats.has(r.nombre)) stats.set(r.nombre, { minutos: 0, cantidad: 0 });
    const s = stats.get(r.nombre);
    s.minutos += r.minutos_tardanza || 0;
    s.cantidad += 1;
  });
  const entradas = [...stats.entries()].sort((a, b) => b[1].minutos - a[1].minutos);
  const ctx = document.getElementById("chartMinutosTardanza");
  const alturaPorBarra = 28;
  ctx.parentElement.style.height = `${Math.max(220, entradas.length * alturaPorBarra + 60)}px`;

  charts.minutosTardanza = new Chart(ctx, {
    type: "bar",
    data: {
      labels: entradas.map((e) => e[0]),
      datasets: [{ label: "Minutos acumulados", data: entradas.map((e) => e[1].minutos), backgroundColor: "#3B79D1", borderRadius: 2, barThickness: 16 }],
    },
    plugins: [pluginValorAlFinal],
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 24 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const s = entradas[item.dataIndex][1];
              const promedio = s.cantidad ? Math.round(s.minutos / s.cantidad) : 0;
              return [
                `Minutos acumulados: ${formatMinutos(s.minutos, { conEquivalencia: true })}`,
                `Cantidad de tardanzas: ${s.cantidad}`,
                `Promedio por tardanza: ${formatMinutos(promedio)}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Minutos", font: { family: FUENTE_UI, size: 10 } },
          ticks: { font: { family: FUENTE_MONO, size: 10 } },
          grid: { color: "#E4E6EC" },
        },
        y: { ticks: { font: { family: FUENTE_UI, size: 11 }, autoSkip: false }, grid: { display: false } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// TABLA DE AUDITORÍA (con tira de ruta como firma visual)
// ---------------------------------------------------------------------------
function tagEstado(r) {
  if (r.tiene_marcacion_abierta) {
    return `<span class="tag tag-rojo" title="Marcación abierta: la persona registró una entrada a un punto de venta pero no se encontró la marcación de salida correspondiente ese día.">● Abierta</span>`;
  }
  const map = {
    [ESTADOS.SUPERVISAR]: "tag-rojo",
    [ESTADOS.LEVE]: "tag-ambar",
    [ESTADOS.SIN_ENTRADA]: "tag-gris",
    [ESTADOS.PUNTUAL]: "tag-verde",
  };
  const clase = map[r.clasificacion_puntualidad] || "tag-gris";
  return `<span class="tag ${clase}">● ${r.clasificacion_puntualidad}</span>`;
}

// Abrevia un nombre de PDV a 3 letras mayúsculas (ej. "Farmacia Norte" -> "FAR")
// para el modo compacto de la ruta visual, conservando el nombre completo en
// el tooltip. Si el nombre tiene varias palabras, toma la primera.
function abreviarPdv(nombre) {
  const primera = String(nombre).trim().split(/\s+/)[0] || "";
  return primera.slice(0, 3).toUpperCase();
}

// Resumen compacto de la ruta para la celda de la tabla (el detalle completo
// con horarios de entrada/salida de cada parada aparece en el desplegable al
// tocar el nombre del colaborador — ver filaDetalleRuta()).
function tiraDeRuta(r) {
  const nombres = r.pdvs_secuencia && r.pdvs_secuencia.length
    ? r.pdvs_secuencia
    : (r.lista_pdvs ? r.lista_pdvs.split("; ") : []);
  if (!nombres.length) return `<span class="muted">Sin registro de ruta</span>`;
  const abrevs = nombres.map((pdv) => `<span class="ruta-chip" title="${pdv}">${abreviarPdv(pdv)}</span>`).join("");
  return `<div class="ruta-strip">${abrevs}<span class="ruta-count">(${nombres.length})</span></div>`;
}

let limiteDescansoActual = 60; // se refresca en arrancarApp() y tras guardar configuración

function celdaCobertura(r) {
  if (r.ruta_cumplida === null || r.ruta_cumplida === undefined) return `<span class="muted">—</span>`;
  const total = r.ruta_pdvs_esperados.length;
  const visitadosCount = total - r.ruta_pdvs_faltantes.length;
  if (r.ruta_cumplida) return `<span class="tag tag-verde">● ${visitadosCount}/${total}</span>`;
  const tituloFaltantes = `Faltó visitar: ${r.ruta_pdvs_faltantes.join(", ")}`;
  return `<span class="tag tag-rojo" title="${tituloFaltantes}">● ${visitadosCount}/${total}</span>`;
}

// Contenido del desplegable "Ruta del día": si la persona tiene ruta
// asignada ese día, lista los PDV que DEBÍA visitar con check/cruz y su
// horario real (si los visitó). Si no tiene ruta asignada, lista los PDV
// que efectivamente visitó (sin comparar contra nada, tal como se acordó).
function filaDetalleRuta(r) {
  const tieneRutaAsignada = r.ruta_pdvs_detalle !== null && r.ruta_pdvs_detalle !== undefined;

  if (tieneRutaAsignada) {
    if (!r.ruta_pdvs_detalle.length) {
      return `<p class="muted small">No hay puntos de venta asignados para este día.</p>`;
    }
    const filasDetalle = r.ruta_pdvs_detalle
      .map(
        (p) => `
      <tr>
        <td>${p.pdv}</td>
        <td class="detalle-check">${p.visitado ? '<span class="check-ok" title="Visitado">✓</span>' : '<span class="check-no" title="No visitado">✗</span>'}</td>
        <td class="mono">${p.entrada || "—"}</td>
        <td class="mono">${p.abierta ? '<span class="tag tag-rojo">Abierta</span>' : (p.salida || "—")}</td>
      </tr>`
      )
      .join("");
    return `
      <table class="detalle-ruta-tabla">
        <thead><tr><th>Punto de venta asignado</th><th>Visitó</th><th>Entrada</th><th>Salida</th></tr></thead>
        <tbody>${filasDetalle}</tbody>
      </table>`;
  }

  // Sin ruta asignada: se muestra lo que efectivamente visitó, sin evaluar cumplimiento.
  if (!r.ruta_detalle || !r.ruta_detalle.length) {
    return `<p class="muted small">Sin ruta asignada para este colaborador y sin visitas registradas este día.</p>`;
  }
  const filasVisitas = r.ruta_detalle
    .map(
      (p) => `
    <tr>
      <td>${p.pdv}</td>
      <td class="mono">${p.entrada || "—"}</td>
      <td class="mono">${p.abierta ? '<span class="tag tag-rojo">Abierta</span>' : (p.salida || "—")}</td>
    </tr>`
    )
    .join("");
  return `
    <p class="muted small">Este colaborador no tiene ruta asignada — se muestran los puntos de venta que efectivamente visitó.</p>
    <table class="detalle-ruta-tabla">
      <thead><tr><th>Punto de venta visitado</th><th>Entrada</th><th>Salida</th></tr></thead>
      <tbody>${filasVisitas}</tbody>
    </table>`;
}

function renderTabla(df) {
  const filasOrdenadas = [...df].sort((a, b) => (a.fecha + a.nombre).localeCompare(b.fecha + b.nombre));

  const totalFilas = filasOrdenadas.length;
  const totalPaginas = Math.max(1, Math.ceil(totalFilas / filasPorPagina));
  if (paginaActual > totalPaginas) paginaActual = totalPaginas;
  if (paginaActual < 1) paginaActual = 1;

  const inicio = (paginaActual - 1) * filasPorPagina;
  const filasPagina = filasOrdenadas.slice(inicio, inicio + filasPorPagina);

  const COLSPAN_TOTAL = 12; // Colaborador + Fecha + Entrada + Salida + Estado + Min.desde08 + Descanso + PDV + Ruta + Horas + Jornada + Cobertura
  const tbody = document.querySelector("#tablaAuditoria tbody");
  tbody.innerHTML = filasPagina
    .map((r, idx) => {
      const inconsistenciaTitle = r.tiene_inconsistencia ? (r.inconsistencias || []).join("; ") : "";
      const rowKey = `fila-${idx}`;
      return `
    <tr class="${r.alerta_exceso_descanso ? "fila-exceso" : ""} ${r.tiene_inconsistencia ? "fila-inconsistente" : ""}" data-rowkey="${rowKey}">
      <td class="td-nombre th-sticky td-expandible" data-toggle="${rowKey}" title="Tocar para ver el detalle de la ruta del día">
        <span class="expand-icono" aria-hidden="true">▸</span>
        ${r.nombre || "Sin datos"}${r.tiene_inconsistencia ? ` <span class="info-icon" title="${inconsistenciaTitle}">⚠</span>` : ""}
      </td>
      <td class="mono">${fechaLegible(r.fecha)}</td>
      <td class="mono">${r.primer_checkin || "—"}</td>
      <td class="mono">${r.ultimo_checkout || (r.tiene_marcacion_abierta ? "Abierta" : "—")}</td>
      <td>${tagEstado(r)}</td>
      <td class="mono num">${formatMinutos(r.minutos_tardanza)}</td>
      <td class="mono num">${formatDescanso(r.minutos_descanso_total, limiteDescansoActual)}</td>
      <td class="mono num">${r.pdvs_unicos_visitados ?? 0}</td>
      <td>${tiraDeRuta(r)}</td>
      <td class="mono num">${formatHorasTrabajadas(r.minutos_efectivos)}</td>
      <td>${r.minutos_efectivos === null ? `<span class="muted">—</span>` : r.cumplio_jornada ? `<span class="tag tag-verde">● Cumplida</span>` : `<span class="tag tag-ambar">● Incompleta</span>`}</td>
      <td>${celdaCobertura(r)}</td>
    </tr>
    <tr class="fila-detalle-ruta hidden" data-rowkey-detalle="${rowKey}">
      <td colspan="${COLSPAN_TOTAL}">${filaDetalleRuta(r)}</td>
    </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".td-expandible").forEach((celda) => {
    celda.addEventListener("click", () => {
      const key = celda.dataset.toggle;
      const detalle = tbody.querySelector(`[data-rowkey-detalle="${key}"]`);
      const icono = celda.querySelector(".expand-icono");
      if (!detalle) return;
      const abierta = !detalle.classList.contains("hidden");
      detalle.classList.toggle("hidden");
      icono.textContent = abierta ? "▸" : "▾";
    });
  });

  renderPaginacion(totalFilas, totalPaginas, inicio);
}

function renderPaginacion(totalFilas, totalPaginas, inicio) {
  const infoEl = document.getElementById("paginacionInfo");
  const botonesEl = document.getElementById("paginacionBotones");
  if (!infoEl || !botonesEl) return;

  const desde = totalFilas === 0 ? 0 : inicio + 1;
  const hasta = Math.min(inicio + filasPorPagina, totalFilas);
  infoEl.textContent = `Mostrando ${desde} a ${hasta} de ${totalFilas} registro(s)`;

  const paginas = [];
  const ventana = 2;
  for (let p = 1; p <= totalPaginas; p++) {
    if (p === 1 || p === totalPaginas || Math.abs(p - paginaActual) <= ventana) paginas.push(p);
    else if (paginas[paginas.length - 1] !== "…") paginas.push("…");
  }

  const botonesHtml = [
    `<button type="button" class="pg-btn" data-pg="prev" ${paginaActual <= 1 ? "disabled" : ""} aria-label="Página anterior">«</button>`,
    ...paginas.map((p) =>
      p === "…"
        ? `<span class="pg-elipsis">…</span>`
        : `<button type="button" class="pg-btn${p === paginaActual ? " activo" : ""}" data-pg="${p}">${p}</button>`
    ),
    `<button type="button" class="pg-btn" data-pg="next" ${paginaActual >= totalPaginas ? "disabled" : ""} aria-label="Página siguiente">»</button>`,
  ].join("");
  botonesEl.innerHTML = botonesHtml;

  botonesEl.querySelectorAll(".pg-btn[data-pg]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dato = btn.dataset.pg;
      if (dato === "prev") paginaActual = Math.max(1, paginaActual - 1);
      else if (dato === "next") paginaActual = Math.min(totalPaginas, paginaActual + 1);
      else paginaActual = parseInt(dato, 10);
      renderTabla(ultimoDfTabla);
    });
  });
}

document.getElementById("filasPorPaginaSelect").addEventListener("change", (e) => {
  filasPorPagina = parseInt(e.target.value, 10) || 15;
  paginaActual = 1;
  renderTabla(ultimoDfTabla);
});

// ---------------------------------------------------------------------------
// EXPORTACIÓN (respeta los filtros activos: colaborador, estado, fechas)
// ---------------------------------------------------------------------------
function resumenFiltrosActivos() {
  const empSel = msEmpleado.getSeleccionados();
  const estSel = msEstado.getSeleccionados();
  const desde = document.getElementById("filtroFechaDesde").value;
  const hasta = document.getElementById("filtroFechaHasta").value;
  return {
    colaboradores: empSel.length ? empSel.join(", ") : "Todos los colaboradores",
    estados: estSel.length ? estSel.join(", ") : "Todos los estados",
    rango: desde && hasta ? `${fechaLegible(desde)} – ${fechaLegible(hasta)}` : "Sin restricción de fecha",
  };
}

document.getElementById("exportExcelBtn").addEventListener("click", async () => {
  if (!dfFiltradoActual.length) {
    alert("No hay registros para exportar con los filtros actuales.");
    return;
  }
  const periodos = obtenerPeriodosSeleccionados();
  const etiquetaPeriodo = periodos.length === 1 ? periodos[0] : `Comparativa_${periodos.join("-")}`;
  const marcacionesPorPeriodo = await Promise.all(periodos.map(obtenerMarcacionesDf));
  const marcaciones = marcacionesPorPeriodo.flat();
  const metaExport = {
    periodoTexto: periodos.map(nombreMes).join(", "),
    filtros: resumenFiltrosActivos(),
    limiteDescanso: limiteDescansoActual,
  };
  exportarExcelConsolidado(dfFiltradoActual, marcaciones, etiquetaPeriodo, metaExport);
});

document.getElementById("exportPdfBtn").addEventListener("click", () => {
  const fecha = document.getElementById("fechaPdf").value;
  if (!fecha) return;
  const registrosDelDia = cacheResumen.filter((r) => r.fecha === fecha);
  exportarPdfResumenDiario(registrosDelDia, fecha, limiteDescansoActual);
});

// ---------------------------------------------------------------------------
// ARRANQUE
// ---------------------------------------------------------------------------
async function arrancarApp() {
  actualizarReloj();
  await asegurarConfiguracionInicial();
  await poblarPanelConfiguracion();
  msEmpleado = crearMultiSelect("msEmpleado", "Todos los colaboradores");
  msEstado = crearMultiSelect("msEstado", "Todos los estados");
  msPdv = crearMultiSelect("msPdv", "Todos los PDV");
  msEmpleado.onChange(() => { paginaActual = 1; aplicarFiltrosYRenderizar(); });
  msEstado.onChange(() => { paginaActual = 1; aplicarFiltrosYRenderizar(); });
  msPdv.onChange(() => { paginaActual = 1; aplicarFiltrosYRenderizar(); });
  const cfg = await cargarConfiguracion();
  limiteDescansoActual = cfg.descansoPermitidoMin;
  await poblarPanelSincronizacionRutas();
  // Solo se cargan los períodos disponibles para poblar los selectores; el
  // dashboard permanece oculto hasta que el usuario suba un Excel, cambie el
  // período, o pulse "Ver historial guardado".
  await refrescarListaDePeriodos();
}

arrancarApp();
