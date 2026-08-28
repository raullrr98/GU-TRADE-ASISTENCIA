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

    // 3a) Traer la versión más reciente del catálogo de rutas antes de
    //     evaluar cumplimiento — siempre, automáticamente, sin que el
    //     usuario tenga que configurar nada (best-effort: si falla, sin
    //     internet o la hoja aún no está publicada, se sigue con lo último
    //     guardado localmente).
    await sincronizarRutasFija();

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
// SINCRONIZACIÓN AUTOMÁTICA CON GOOGLE SHEETS (enlace fijo, sin configuración
// manual del usuario). El sheet queda vinculado permanentemente al tablero:
// se sincroniza solo al abrir la app y cada vez que se procesa un Excel.
//
// ⚠️ IMPORTANTE PARA QUIEN DESPLIEGUE ESTE TABLERO: reemplazar el valor de
// RUTAS_SHEET_URL_FIJA por el enlace real de exportación CSV de la hoja de
// rutas PUBLICADA en Google Sheets:
//   Google Sheets → Archivo → Compartir → Publicar en la web →
//   elegir la hoja con las rutas por persona → formato CSV → Publicar →
//   copiar el enlace (termina en "pub?output=csv" o similar).
// Sin este enlace configurado, el tablero sigue funcionando normalmente
// (todo se mide igual), solo que ningún colaborador tendrá ruta asignada
// para evaluar cumplimiento.
// ---------------------------------------------------------------------------
const RUTAS_SHEET_URL_FIJA = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRK4wtwFyLxQBqi-kzf_nzzUTNjtnixGUmn2fAGAxQ2RT7cMkLOZ0tQdpCxw4lq_qmNLDIZUoaudId9/pub?output=csv";

function urlRutasConfigurada() {
  return RUTAS_SHEET_URL_FIJA && !RUTAS_SHEET_URL_FIJA.startsWith("PEGAR_AQUI");
}

function actualizarFootnoteSyncRutas(texto) {
  const el = document.getElementById("rutasSyncFootnote");
  if (el) el.textContent = texto;
}

/**
 * Descarga la hoja de rutas publicada en Google Sheets (CSV, enlace fijo en
 * el código) y actualiza el catálogo local. Se llama sola al abrir la app y
 * después de procesar cada Excel de marcaciones — nunca requiere una acción
 * manual del usuario.
 */
async function sincronizarRutasFija() {
  if (!urlRutasConfigurada()) {
    actualizarFootnoteSyncRutas("Rutas asignadas: enlace no configurado (ver app.js)");
    return false;
  }
  actualizarFootnoteSyncRutas("Rutas asignadas: sincronizando...");
  try {
    const respuesta = await fetch(RUTAS_SHEET_URL_FIJA, { cache: "no-store" });
    if (!respuesta.ok) {
      throw new Error(`Google Sheets respondió con error ${respuesta.status}`);
    }
    const textoCSV = await respuesta.text();
    const { asignaciones, meta } = leerRutasAsignadasDesdeCSV(textoCSV);
    if (!asignaciones.length) throw new Error("La hoja no tiene filas válidas");

    await dbClearStore("rutas_asignadas");
    await dbPutMany("rutas_asignadas", asignaciones);
    await recalcularTodoElHistorico();
    const dashboardYaVisible = !document.getElementById("dashboardContent").classList.contains("hidden");
    if (dashboardYaVisible) await refrescarPeriodosYVista();

    const ahora = new Date();
    const horaTexto = ahora.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    actualizarFootnoteSyncRutas(`Rutas asignadas: sincronizado ${horaTexto} · ${meta.filasValidas} fila(s)`);
    return true;
  } catch (err) {
    console.warn("No se pudo sincronizar la hoja de rutas:", err.message);
    actualizarFootnoteSyncRutas("Rutas asignadas: no se pudo sincronizar (se sigue usando lo último guardado)");
    return false;
  }
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
    window.__calSincronizarDesdeInputs?.();
  }
}

document.getElementById("buscarColaboradorInput").addEventListener("input", () => {
  paginaActual = 1;
  aplicarFiltrosYRenderizar();
});

["filtroFechaDesde", "filtroFechaHasta"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => { paginaActual = 1; aplicarFiltrosYRenderizar(); });
});

// ---------------------------------------------------------------------------
// SELECTOR DE CALENDARIO CON RANGO (reemplaza los campos sueltos Desde/Hasta)
// ---------------------------------------------------------------------------
function fechaAISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoADate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// MODO OSCURO (persistente, igual patrón que la referencia +Marka)
// ---------------------------------------------------------------------------
function inicializarModoOscuro() {
  const btn = document.getElementById("themeToggleBtn");
  const icono = document.getElementById("themeIcon");
  const label = document.getElementById("themeLabel");

  function aplicar(oscuro) {
    document.body.classList.toggle("tema-oscuro", oscuro);
    icono.textContent = oscuro ? "☀️" : "🌙";
    label.textContent = oscuro ? "Modo claro" : "Modo oscuro";
  }

  const guardado = localStorage.getItem("gu_trade_tema") === "oscuro";
  aplicar(guardado);

  btn.addEventListener("click", () => {
    const oscuro = !document.body.classList.contains("tema-oscuro");
    aplicar(oscuro);
    localStorage.setItem("gu_trade_tema", oscuro ? "oscuro" : "claro");
  });
}

function initCalendario() {
  const btn = document.getElementById("calBtn");
  const panel = document.getElementById("calPanel");
  const inputDesde = document.getElementById("filtroFechaDesde");
  const inputHasta = document.getElementById("filtroFechaHasta");
  const labelEl = document.getElementById("calBtnLabel");
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const DIAS = ["DO", "LU", "MA", "MI", "JU", "VI", "SA"];

  let viewMonth = new Date();
  let calStart = null, calEnd = null;

  function actualizarLabel() {
    if (!calStart) labelEl.textContent = "Todas las fechas";
    else if (!calEnd || calEnd === calStart) labelEl.textContent = fechaLegible(calStart);
    else labelEl.textContent = `${fechaLegible(calStart)} → ${fechaLegible(calEnd)}`;
  }

  function sincronizarInputs() {
    inputDesde.value = calStart || "";
    inputHasta.value = calEnd || calStart || "";
    inputDesde.dispatchEvent(new Event("change"));
  }

  function render() {
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth();
    const primerDia = new Date(y, m, 1);
    const diasEnMes = new Date(y, m + 1, 0).getDate();
    const inicioSemana = primerDia.getDay();
    const hoyISO = fechaAISO(new Date());
    const lo = calStart && calEnd ? (calStart <= calEnd ? calStart : calEnd) : calStart;
    const hi = calStart && calEnd ? (calStart <= calEnd ? calEnd : calStart) : calStart;

    let diasHtml = "";
    for (let i = 0; i < inicioSemana; i++) diasHtml += "<div></div>";
    for (let d = 1; d <= diasEnMes; d++) {
      const iso = fechaAISO(new Date(y, m, d));
      let clase = "cal-day";
      if (iso === hoyISO) clase += " hoy";
      if (lo && hi && iso >= lo && iso <= hi) clase += " en-rango";
      if (iso === lo) clase += " rango-inicio";
      if (iso === hi) clase += " rango-fin";
      diasHtml += `<div class="${clase}" data-fecha="${iso}">${d}</div>`;
    }

    const rangoLabel = calStart ? (calEnd && calEnd !== calStart ? `${calStart} → ${calEnd}` : calStart) : "Todas las fechas";
    panel.innerHTML = `
      <div class="cal-presets">
        <span class="cal-preset" data-preset="hoy">Hoy</span>
        <span class="cal-preset" data-preset="7">Últimos 7 días</span>
        <span class="cal-preset" data-preset="15">Últimos 15 días</span>
        <span class="cal-preset" data-preset="30">Últimos 30 días</span>
        <span class="cal-preset" data-preset="todo">Todo</span>
      </div>
      <div class="cal-head">
        <button type="button" class="cal-nav" data-nav="-1">‹</button>
        <span class="cal-month">${MESES[m]} ${y}</span>
        <button type="button" class="cal-nav" data-nav="1">›</button>
      </div>
      <div class="cal-weekdays">${DIAS.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cal-days">${diasHtml}</div>
      <div class="cal-foot">
        <span class="cal-range-label"><strong>${rangoLabel}</strong></span>
        <button type="button" class="btn-ghost btn-small" id="calLimpiarBtn">Limpiar</button>
      </div>
    `;

    panel.querySelectorAll(".cal-day[data-fecha]").forEach((el) => {
      el.addEventListener("click", () => {
        const iso = el.dataset.fecha;
        const tieneRangoCompleto = calStart && calEnd;
        if (!calStart || tieneRangoCompleto) {
          calStart = iso;
          calEnd = null;
        } else if (iso < calStart) {
          calEnd = calStart;
          calStart = iso;
        } else {
          calEnd = iso;
        }
        render();
        actualizarLabel();
        sincronizarInputs();
      });
    });
    panel.querySelectorAll(".cal-nav").forEach((el) => {
      el.addEventListener("click", () => {
        viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + parseInt(el.dataset.nav, 10), 1);
        render();
      });
    });
    panel.querySelectorAll(".cal-preset").forEach((el) => {
      el.addEventListener("click", () => {
        const p = el.dataset.preset;
        const hoy = new Date();
        const hoyIso = fechaAISO(hoy);
        if (p === "todo") {
          calStart = null;
          calEnd = null;
        } else if (p === "hoy") {
          calStart = hoyIso;
          calEnd = hoyIso;
        } else {
          const desde = new Date(hoy);
          desde.setDate(desde.getDate() - (parseInt(p, 10) - 1));
          calStart = fechaAISO(desde);
          calEnd = hoyIso;
        }
        if (calStart) viewMonth = isoADate(calStart);
        render();
        actualizarLabel();
        sincronizarInputs();
      });
    });
    document.getElementById("calLimpiarBtn").addEventListener("click", () => {
      calStart = null;
      calEnd = null;
      render();
      actualizarLabel();
      sincronizarInputs();
    });
  }

  btn.addEventListener("click", () => {
    const abrir = !panel.classList.contains("abierto");
    panel.classList.toggle("abierto", abrir);
    btn.classList.toggle("abierto", abrir);
    if (abrir) render();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".cal-wrap")) {
      panel.classList.remove("abierto");
      btn.classList.remove("abierto");
    }
  });

  // Otras funciones (poblarFiltrosDinamicos, "Limpiar filtros") necesitan
  // poder sincronizar el estado interno del calendario cuando cambian las
  // fechas por otra vía (ej. al cargar un período nuevo).
  window.__calSincronizarDesdeInputs = () => {
    calStart = inputDesde.value || null;
    calEnd = inputHasta.value || null;
    actualizarLabel();
  };
  window.__calLimpiar = () => {
    calStart = null;
    calEnd = null;
    actualizarLabel();
  };
}

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
    window.__calSincronizarDesdeInputs?.();
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

  // Cantidad de COLABORADORES distintos con al menos una tardanza en el
  // período filtrado (no cantidad de eventos): si 10 colaboradores llegaron
  // tarde alguna vez en el rango de fechas, el valor es 10, aunque alguno
  // de ellos haya llegado tarde varios días.
  const colaboradoresConTardanza = new Set(
    df.filter((r) => esTardanza(r.clasificacion_puntualidad)).map((r) => r.id_empleado)
  ).size;

  const ICONOS = {
    personas: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.8 14.2c2.8.4 5.2 2.4 5.2 5.8"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9.2"/><path d="m8 12.5 2.6 2.6L16.5 9"/></svg>',
    alerta: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9.2"/><path d="M12 7v6"/><circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none"/></svg>',
  };

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
      titulo: "Cantidad de tardanzas por colaborador",
      valor: colaboradoresConTardanza,
      unidad: "colaboradores",
      icono: ICONOS.alerta,
      claseIcono: "kpi-icono-rojo",
      desc: "Colaboradores distintos con al menos una llegada tarde (desde las 08:11) en el rango filtrado.",
      tooltip: "Cuenta colaboradores únicos, no eventos: si 10 colaboradores llegaron tarde alguna vez en el rango de fechas seleccionado, el valor es 10, sin importar cuántas veces llegó tarde cada uno.",
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

// Contenido del desplegable "Ruta del día": SIEMPRE muestra la línea de
// tiempo completa del día (PDV + almuerzo/descanso + traslados, en orden
// cronológico), con minutos por parada. Si la persona tiene ruta asignada
// ese día, además marca check/cruz en cada PDV esperado y agrega al final
// los que faltó visitar. Termina con una fila de total de horas del día.
function filaDetalleRuta(r) {
  const timeline = r.jornada_detalle || [];
  const tieneRutaAsignada = r.ruta_pdvs_detalle !== null && r.ruta_pdvs_detalle !== undefined;
  const esperadosNormalizados = tieneRutaAsignada
    ? new Set((r.ruta_pdvs_esperados || []).map((p) => p.trim().toLowerCase()))
    : null;

  if (!timeline.length) {
    return `<p class="muted small">Sin marcaciones registradas este día.</p>`;
  }

  const notaRuta = tieneRutaAsignada
    ? `<p class="muted small">Este colaborador tiene ruta asignada — se marca con ✓/✗ si cumplió cada punto esperado.</p>`
    : `<p class="muted small">Este colaborador no tiene ruta asignada — se muestra lo que efectivamente hizo en el día, sin evaluar cumplimiento.</p>`;

  const filasTimeline = timeline
    .map((item) => {
      let columnaVisito = `<span class="muted">—</span>`;
      if (tieneRutaAsignada && item.tipo === "PDV") {
        const esEsperado = esperadosNormalizados.has(item.nombre.trim().toLowerCase());
        if (esEsperado) columnaVisito = '<span class="check-ok" title="Visitado">✓</span>';
      }
      const salidaTexto = item.abierta ? `<span class="tag tag-rojo">Abierta</span>` : (item.salida || "—");
      return `
      <tr>
        <td>${item.nombre}</td>
        <td class="detalle-check">${columnaVisito}</td>
        <td class="mono">${item.entrada || "—"}</td>
        <td class="mono">${salidaTexto}</td>
        <td class="mono num">${formatMinutos(item.minutos)}</td>
      </tr>`;
    })
    .join("");

  // Puntos esperados que directamente NO se visitaron en absoluto ese día
  // (no aparecen ni siquiera como parada en la línea de tiempo).
  const filasFaltantes = tieneRutaAsignada
    ? (r.ruta_pdvs_faltantes || [])
        .map(
          (pdv) => `
      <tr>
        <td>${pdv}</td>
        <td class="detalle-check"><span class="check-no" title="No visitado">✗</span></td>
        <td class="mono">—</td>
        <td class="mono">—</td>
        <td class="mono num">—</td>
      </tr>`
        )
        .join("")
    : "";

  const filaTotal = `
    <tr class="detalle-total-fila">
      <td colspan="4"><strong>Total de horas realizadas en el día</strong></td>
      <td class="mono num"><strong>${formatHorasTrabajadas(r.minutos_trabajados)}</strong></td>
    </tr>`;

  return `
    ${notaRuta}
    <table class="detalle-ruta-tabla">
      <thead><tr><th>Punto / Actividad</th><th>Visitó</th><th>Entrada</th><th>Salida</th><th>Minutos</th></tr></thead>
      <tbody>${filasTimeline}${filasFaltantes}${filaTotal}</tbody>
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
  initCalendario();
  inicializarModoOscuro();
  const cfg = await cargarConfiguracion();
  limiteDescansoActual = cfg.descansoPermitidoMin;
  // Sincroniza las rutas asignadas apenas se abre la app (enlace fijo, sin
  // ninguna acción del usuario) y luego solo carga la lista de períodos
  // disponibles; el dashboard permanece oculto hasta pulsar "Siguiente" en
  // la pantalla de bienvenida (paso obligatorio, confirmado con el usuario).
  await sincronizarRutasFija();
  await refrescarListaDePeriodos();
}

arrancarApp();
