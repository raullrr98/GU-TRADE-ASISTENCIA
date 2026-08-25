// ============================================================================
// businessLogic.js — Cálculo de asistencia_resumen_diario a partir de las
// filas limpias que produce etl.js.
//
// REGLA CENTRAL DE ASISTENCIA (única fuente de verdad para todo el sistema:
// tarjetas, tabla, gráficos, filtros, Excel y PDF usan clasificarPuntualidad):
//   - Hora oficial de entrada: 08:00 (configurable)
//   - Tolerancia: 10 minutos (configurable)
//   - Entrada hasta 08:10 inclusive (<=10 min desde las 08:00)  -> "Puntual"
//   - Entrada de 08:11 a 08:29 inclusive (11-29 min)            -> "Tardanza Leve"
//   - Entrada desde 08:30 en adelante (>=30 min)                -> "Tardanza a Supervisar"
//   - Sin marcación de entrada válida                           -> "Sin Entrada"
//
// Los minutos mostrados ("MIN. DESDE LAS 08:00") NUNCA descuentan la
// tolerancia: una entrada a las 08:26 siempre muestra "26 min", aunque su
// estado sea "Tardanza Leve" gracias a la tolerancia de 10 minutos.
// ============================================================================

const ACTIVIDADES_DESCANSO = new Set(["descanso", "break", "almuerzo"]);
const ACTIVIDADES_TRASLADO = new Set(["traslado", "transporte", "movilizacion", "movilización"]);

// Nombres de estado centralizados: todo el código (app.js, reportsClient.js)
// debe usar estas constantes en vez de escribir el texto a mano, para que un
// cambio de nombre futuro no vuelva a desincronizar tarjetas/tabla/gráficos.
const ESTADOS = {
  PUNTUAL: "Puntual",
  LEVE: "Tardanza Leve",
  SUPERVISAR: "Tardanza a Supervisar",
  SIN_ENTRADA: "Sin Entrada",
};
const ESTADOS_TARDANZA = [ESTADOS.LEVE, ESTADOS.SUPERVISAR];

function esTardanza(estado) {
  return ESTADOS_TARDANZA.includes(estado);
}

function norm(txt) {
  return txt ? String(txt).trim().toLowerCase() : "";
}

// Normalización simple para comparar nombres (persona o PDV) entre dos
// archivos distintos. Duplicada intencionalmente respecto a la de etl.js
// (que hace lo mismo para nombres de persona) para que businessLogic.js no
// dependa de que etl.js se haya cargado antes en la página.
function normalizarClaveTexto(txt) {
  return String(txt || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function horaAMinutos(horaStr) {
  if (!horaStr) return null;
  const partes = horaStr.split(":");
  if (partes.length < 2) return null;
  const h = parseInt(partes[0], 10);
  const m = parseInt(partes[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * FUNCIÓN CENTRAL — determina el estado de asistencia de una entrada.
 * Usada por calcularResumen (que alimenta tarjetas, tabla, gráficos y
 * filtros) y reutilizada tal cual por las exportaciones a Excel y PDF, para
 * que sea IMPOSIBLE que un componente muestre un estado distinto a otro.
 *
 * @param {number} minutosDesdeOficial - minutos transcurridos desde la hora
 *   oficial de entrada, SIN restar la tolerancia (ej. entrada 08:26 -> 26).
 * @param {boolean} huboEntrada - false si no existe marcación de entrada.
 * @param {number} toleranciaMin - minutos de tolerancia (default 10).
 * @param {number} leveMaxMin - minuto máximo (absoluto, desde la hora
 *   oficial) hasta el cual una entrada tardía se considera "leve" antes de
 *   pasar a "a supervisar" (default 29, i.e. hasta las 08:29 inclusive).
 */
function clasificarPuntualidad(minutosDesdeOficial, huboEntrada, toleranciaMin, leveMaxMin) {
  if (!huboEntrada) return ESTADOS.SIN_ENTRADA;
  if (minutosDesdeOficial <= toleranciaMin) return ESTADOS.PUNTUAL;
  if (minutosDesdeOficial <= leveMaxMin) return ESTADOS.LEVE;
  return ESTADOS.SUPERVISAR;
}

// ---------------------------------------------------------------------------
// FORMATO CENTRALIZADO DE MINUTOS — usado por app.js y reportsClient.js para
// que ningún lugar del dashboard muestre un número de tiempo sin su unidad.
// ---------------------------------------------------------------------------
function formatMinutos(minutos, opciones) {
  opciones = opciones || {};
  if (minutos === null || minutos === undefined || Number.isNaN(minutos) || !Number.isFinite(minutos)) {
    return "—";
  }
  const val = Math.round(minutos);
  let texto = `${val} min`;
  if (opciones.conEquivalencia && Math.abs(val) >= 60) {
    const signo = val < 0 ? "-" : "";
    const abs = Math.abs(val);
    const horas = Math.floor(abs / 60);
    const resto = abs % 60;
    texto += ` (${signo}${horas} h${resto ? " " + resto + " min" : ""})`;
  }
  return texto;
}

// Formatea el descanso mostrando el exceso respecto al límite permitido, sin
// ambigüedad ("61 min (+1 min)" en vez de "61 +1"). Si no hay límite definido
// (limite es null/undefined), solo muestra la duración.
function formatDescanso(minutosRegistrados, limite) {
  const base = formatMinutos(minutosRegistrados);
  if (limite === null || limite === undefined || minutosRegistrados === null || minutosRegistrados === undefined) {
    return base;
  }
  const exceso = minutosRegistrados - limite;
  return exceso > 0 ? `${base} (+${exceso} min)` : base;
}

// Formatea la duración de una jornada como "9h 01m", pensado para leerse
// más naturalmente que "541 min (9 h 1 min)" en la columna de horas trabajadas.
function formatHorasTrabajadas(minutos) {
  if (minutos === null || minutos === undefined || Number.isNaN(minutos) || !Number.isFinite(minutos)) {
    return "—";
  }
  const val = Math.round(minutos);
  const horas = Math.floor(val / 60);
  const resto = val % 60;
  return `${horas}h ${String(resto).padStart(2, "0")}m`;
}

/**
 * Agrupa las filas limpias por (empleado, fecha) y calcula, para cada grupo,
 * el resumen diario de asistencia. Devuelve un array de objetos listos para
 * guardar en la tabla asistencia_resumen_diario.
 *
 * @param {Array} filas - salida de etl.leerYLimpiarExcel()
 * @param {Object} config - { horaEntradaTeorica: "08:00", toleranciaMin: 10,
 *                            tardanzaLeveMaxMin: 29, descansoPermitidoMin: 60 }
 */
function calcularResumen(filas, config) {
  const horaEntradaTeoMin = horaAMinutos(config.horaEntradaTeorica) ?? 480;
  const horasJornadaEsperadaMin = (config.horasJornadaEsperada ?? 8) * 60;
  const tolerancia = config.toleranciaMin ?? 10;
  const leveMaxMin = config.tardanzaLeveMaxMin ?? 29;
  const descansoPermitido = config.descansoPermitidoMin ?? 60;

  // Agrupar por empleado+fecha
  const grupos = new Map();
  for (const f of filas) {
    const clave = `${f.id_empleado}|${f.fecha}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(f);
  }

  const resumenes = [];
  for (const [clave, grupo] of grupos.entries()) {
    const [id_empleado, fecha] = clave.split("|");
    const ordenadas = [...grupo].sort(
      (a, b) => (horaAMinutos(a.hora_inicio) ?? 0) - (horaAMinutos(b.hora_inicio) ?? 0)
    );

    const horasInicioValidas = ordenadas.map((f) => f.hora_inicio).filter(Boolean);
    const horasSalidaValidas = ordenadas.map((f) => f.hora_salida).filter(Boolean);

    const primerCheckin = horasInicioValidas[0] || null;
    const ultimoCheckout = horasSalidaValidas.length ? horasSalidaValidas[horasSalidaValidas.length - 1] : null;

    const huboEntrada = primerCheckin !== null;
    let minutosDesdeOficial = 0;
    if (huboEntrada) {
      const minCheckin = horaAMinutos(primerCheckin);
      if (minCheckin !== null) minutosDesdeOficial = Math.max(0, minCheckin - horaEntradaTeoMin);
    }
    const clasificacion = clasificarPuntualidad(minutosDesdeOficial, huboEntrada, tolerancia, leveMaxMin);

    const minutosDescanso = ordenadas
      .filter((f) => ACTIVIDADES_DESCANSO.has(norm(f.actividad)))
      .reduce((acc, f) => acc + (f.tiempo_transcurrido_min || 0), 0);
    const excesoDescanso = Math.max(0, minutosDescanso - descansoPermitido);

    const minutosTraslado = ordenadas
      .filter((f) => ACTIVIDADES_TRASLADO.has(norm(f.actividad)))
      .reduce((acc, f) => acc + (f.tiempo_transcurrido_min || 0), 0);

    const minutosPdv = ordenadas
      .filter((f) => !ACTIVIDADES_DESCANSO.has(norm(f.actividad)) && !ACTIVIDADES_TRASLADO.has(norm(f.actividad)))
      .reduce((acc, f) => acc + (f.tiempo_transcurrido_min || 0), 0);

    const pdvsVisitados = new Set(
      ordenadas
        .filter((f) => f.punto_venta && !ACTIVIDADES_DESCANSO.has(norm(f.actividad)) && !ACTIVIDADES_TRASLADO.has(norm(f.actividad)))
        .map((f) => f.punto_venta)
    );

    // Identificadores de PDV visitados (ej. "PDV0347"), cuando el Excel de
    // marcaciones los trae — es la clave preferida para cruzar contra la
    // hoja de rutas asignadas (más confiable que el nombre).
    const pdvsIdsVisitados = new Set(
      ordenadas
        .filter((f) => f.id_punto_venta && !ACTIVIDADES_DESCANSO.has(norm(f.actividad)) && !ACTIVIDADES_TRASLADO.has(norm(f.actividad)))
        .map((f) => String(f.id_punto_venta).trim().toLowerCase())
    );

    // Secuencia ordenada cronológicamente (para el desplegable de "Ruta del
    // día"), colapsando visitas consecutivas al mismo PDV. rutaDetalle lleva
    // el horario real de entrada/salida de cada parada (para mostrar "a qué
    // hora entró y salió de cada punto") y si esa parada quedó sin cerrar.
    const secuenciaCruda = ordenadas
      .filter((f) => f.punto_venta && !ACTIVIDADES_DESCANSO.has(norm(f.actividad)) && !ACTIVIDADES_TRASLADO.has(norm(f.actividad)))
      .map((f) => ({
        pdv: f.punto_venta,
        id_pdv: f.id_punto_venta ? String(f.id_punto_venta).trim().toLowerCase() : null,
        entrada: f.hora_inicio,
        salida: f.hora_salida,
        minutos: f.tiempo_transcurrido_min || 0,
        abierta: f.marcacion_abierta,
      }));
    const rutaDetalle = [];
    for (const parada of secuenciaCruda) {
      const anterior = rutaDetalle[rutaDetalle.length - 1];
      if (anterior && anterior.pdv === parada.pdv) {
        // Visita consecutiva al mismo PDV: se combina en una sola parada,
        // sumando minutos y extendiendo la salida hasta la última marcación.
        anterior.minutos += parada.minutos;
        anterior.salida = parada.salida;
        anterior.abierta = parada.abierta;
      } else {
        rutaDetalle.push({ ...parada });
      }
    }
    const pdvsSecuencia = rutaDetalle.map((p) => p.pdv);

    // Horas trabajadas en el día: desde el primer check-in hasta el último
    // check-out (bruto), y horas EFECTIVAS descontando el descanso, que es
    // lo que se compara contra la jornada obligatoria (por defecto 8 h) para
    // determinar si el colaborador cumplió su jornada completa.
    let minutosTrabajados = null;
    let minutosEfectivos = null;
    let cumplioJornada = false;
    if (huboEntrada && ultimoCheckout && !ordenadas.some((f) => f.marcacion_abierta)) {
      const minEntrada = horaAMinutos(primerCheckin);
      const minSalida = horaAMinutos(ultimoCheckout);
      if (minEntrada !== null && minSalida !== null && minSalida >= minEntrada) {
        minutosTrabajados = minSalida - minEntrada;
        minutosEfectivos = Math.max(0, minutosTrabajados - minutosDescanso);
        cumplioJornada = minutosEfectivos >= horasJornadaEsperadaMin;
      }
    }

    const tieneAbierta = ordenadas.some((f) => f.marcacion_abierta);

    // --- Inconsistencias a nivel de día (se conservan y se marcan, no se eliminan) ---
    const inconsistencias = [];
    if (huboEntrada && ultimoCheckout) {
      const minEntrada = horaAMinutos(primerCheckin);
      const minSalida = horaAMinutos(ultimoCheckout);
      if (minEntrada !== null && minSalida !== null && minEntrada > minSalida) {
        inconsistencias.push("Entrada posterior a la salida");
      }
    }
    if (!huboEntrada) inconsistencias.push("Falta marcación de entrada");
    if (tieneAbierta) inconsistencias.push("Falta marcación de salida (marcación abierta)");
    if (minutosDescanso < 0) inconsistencias.push("Descanso con duración negativa");
    if (excesoDescanso > 0) inconsistencias.push(`Descanso excede el límite permitido (+${excesoDescanso} min)`);
    const minutosTotalDia = minutosPdv + minutosTraslado + minutosDescanso;
    if (minutosTotalDia > 24 * 60) inconsistencias.push("Tiempo total del día superior a 24 horas (dato imposible)");
    // Auto-verificación de la regla central (no debería ocurrir nunca; si
    // aparece, es señal de un error de configuración, no de los datos).
    if (clasificacion === ESTADOS.PUNTUAL && minutosDesdeOficial > tolerancia) {
      inconsistencias.push("Verificar regla: clasificado Puntual fuera de tolerancia");
    }
    if (clasificacion !== ESTADOS.PUNTUAL && clasificacion !== ESTADOS.SIN_ENTRADA && minutosDesdeOficial <= tolerancia) {
      inconsistencias.push("Verificar regla: tardanza dentro de tolerancia");
    }

    const [y, mo] = fecha.split("-");

    resumenes.push({
      id_empleado,
      fecha,
      periodo: `${y}-${mo}`,
      primer_checkin: primerCheckin,
      ultimo_checkout: ultimoCheckout,
      minutos_tardanza: minutosDesdeOficial,
      clasificacion_puntualidad: clasificacion,
      minutos_descanso_total: minutosDescanso,
      minutos_exceso_descanso: excesoDescanso,
      alerta_exceso_descanso: excesoDescanso > 0,
      minutos_pdv: minutosPdv,
      minutos_traslado: minutosTraslado,
      pdvs_unicos_visitados: pdvsVisitados.size,
      lista_pdvs: pdvsVisitados.size ? [...pdvsVisitados].sort().join("; ") : null,
      pdvs_secuencia: pdvsSecuencia,
      pdvs_ids_visitados: [...pdvsIdsVisitados],
      ruta_detalle: rutaDetalle,
      minutos_trabajados: minutosTrabajados,
      minutos_efectivos: minutosEfectivos,
      cumplio_jornada: cumplioJornada,
      tiene_marcacion_abierta: tieneAbierta,
      inconsistencias,
      tiene_inconsistencia: inconsistencias.length > 0,
      // Estos cuatro campos los completa evaluarCumplimientoRuta() después,
      // si hay un catálogo de rutas asignadas cargado. Por defecto (sin
      // catálogo, o persona sin ruta asignada) quedan en null = "no medir".
      ruta_pdvs_esperados: null,
      ruta_cumplida: null,
      ruta_pdvs_faltantes: null,
      ruta_pdvs_detalle: null,
    });
  }
  return resumenes;
}

// ---------------------------------------------------------------------------
// CUMPLIMIENTO DE RUTA ASIGNADA
// ---------------------------------------------------------------------------
const DIAS_SEMANA_JS = ["DO", "LU", "MA", "MI", "JU", "VI", "SA"]; // Date.getDay(): 0=domingo

// Convierte "YYYY-MM-DD" al código de día usado en la hoja de rutas (LU..SA).
// Construye la fecha en horario LOCAL (no UTC) para evitar que un huso
// horario negativo corra el día al calcular getDay().
function diaSemanaCodigo(fechaISO) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  return DIAS_SEMANA_JS[fecha.getDay()];
}

/**
 * Enriquece (in-place) el array de resumenes con el cumplimiento de ruta,
 * usando el catálogo de asignaciones (persona + PDV + días obligatorios).
 *
 * Reglas (confirmadas con el usuario):
 *  - Si la persona no aparece en el catálogo de rutas -> no se mide (null).
 *  - Si la persona aparece pero ninguna de sus filas tiene día definido para
 *    la fecha en cuestión -> tampoco se mide ese día (null). Las filas sin
 *    día NUNCA generan una obligación, sea cual sea la fecha.
 *  - Si hay PDVs esperados ese día de la semana -> se compara contra los
 *    PDVs realmente visitados. El cruce se hace PRIMERO por identificador
 *    (ej. "PDV0347", el mismo código que trae el Excel de marcaciones en
 *    "Identificador de Punto de Interés") y, si el catálogo de rutas no
 *    trajo identificador para esa fila, se usa el nombre del PDV como
 *    respaldo. Si falta alguno, se agrega una inconsistencia "Ruta
 *    incompleta: ..." para que aparezca también en la franja de Atención
 *    Requerida sin duplicar lógica.
 *
 * @param {Array} resumenes - salida de calcularResumen(), se modifica in-place
 * @param {Array} asignaciones - salida de etl.leerRutasAsignadas().asignaciones
 * @param {Map} nombresPorIdEmpleado - Map(id_empleado -> nombre), para poder
 *   cruzar por nombre ya que el catálogo de rutas no trae ID de empleado.
 */
function evaluarCumplimientoRuta(resumenes, asignaciones, nombresPorIdEmpleado) {
  if (!asignaciones || !asignaciones.length) return resumenes;

  // Agrupar asignaciones por persona (normalizada), solo las que tienen
  // al menos un día definido (las de "dias: []" nunca generan obligación).
  const porPersona = new Map();
  for (const a of asignaciones) {
    if (!a.dias.length) continue;
    if (!porPersona.has(a.nombre_normalizado)) porPersona.set(a.nombre_normalizado, []);
    porPersona.get(a.nombre_normalizado).push(a);
  }

  for (const r of resumenes) {
    const nombre = nombresPorIdEmpleado.get(r.id_empleado);
    if (!nombre) continue;
    const clave = normalizarClaveTexto(nombre);
    const filasPersona = porPersona.get(clave);
    if (!filasPersona || !filasPersona.length) continue; // persona sin ruta asignada -> no se mide

    const codigoDia = diaSemanaCodigo(r.fecha);
    const asignacionesHoy = filasPersona.filter((f) => f.dias.includes(codigoDia));
    if (!asignacionesHoy.length) continue; // esta persona no tiene obligación este día específico

    // Deduplicar por clave_pdv, conservando el nombre para mostrar en la UI.
    const esperadosMap = new Map(); // clave_pdv -> nombre a mostrar
    for (const a of asignacionesHoy) esperadosMap.set(a.clave_pdv, a.punto_venta);

    // Conjunto combinado de lo efectivamente visitado: identificadores (clave
    // preferida) + nombres normalizados (respaldo), para que el cruce
    // funcione tanto si el catálogo de rutas trae identificador como si no.
    const visitadosClaves = new Set([
      ...(r.pdvs_ids_visitados || []),
      ...(r.pdvs_secuencia || []).map((n) => normalizarClaveTexto(n)),
    ]);

    // Índice por clave (id o nombre normalizado) hacia el detalle real de la
    // visita (entrada/salida), para el desplegable "Ruta del día".
    const detallePorClave = new Map();
    for (const parada of r.ruta_detalle || []) {
      if (parada.id_pdv) detallePorClave.set(parada.id_pdv, parada);
      detallePorClave.set(normalizarClaveTexto(parada.pdv), parada);
    }

    const faltantes = [];
    const esperadosNombres = [];
    const pdvsDetalle = [];
    for (const [clavePdv, nombrePdv] of esperadosMap.entries()) {
      esperadosNombres.push(nombrePdv);
      const visitado = visitadosClaves.has(clavePdv);
      if (!visitado) faltantes.push(nombrePdv);
      const parada = detallePorClave.get(clavePdv);
      pdvsDetalle.push({
        pdv: nombrePdv,
        visitado,
        entrada: parada ? parada.entrada : null,
        salida: parada && !parada.abierta ? parada.salida : null,
        abierta: parada ? !!parada.abierta : false,
      });
    }

    r.ruta_pdvs_esperados = esperadosNombres;
    r.ruta_cumplida = faltantes.length === 0;
    r.ruta_pdvs_faltantes = faltantes;
    r.ruta_pdvs_detalle = pdvsDetalle;

    if (faltantes.length > 0) {
      r.inconsistencias.push(`Ruta incompleta: faltó visitar ${faltantes.join(", ")}`);
      r.tiene_inconsistencia = true;
    }
  }
  return resumenes;
}

if (typeof module !== "undefined") {
  module.exports = {
    calcularResumen,
    clasificarPuntualidad,
    horaAMinutos,
    formatMinutos,
    formatDescanso,
    formatHorasTrabajadas,
    esTardanza,
    diaSemanaCodigo,
    evaluarCumplimientoRuta,
    ESTADOS,
    ESTADOS_TARDANZA,
  };
}
