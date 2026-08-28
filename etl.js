// ============================================================================
// etl.js — Lectura y limpieza del Excel "en bruto" de marcaciones
// Misma lógica que la versión Python (core/etl.py), reescrita en JS puro
// para correr 100% en el navegador (usa SheetJS ya cargado como `XLSX`).
// ============================================================================

const COLUMN_ALIASES = {
  id_empleado: [
    "identificador de persona de interes",
    "id de persona de interes",
    "id persona de interes",
    "id empleado",
    "cedula",
    "documento",
  ],
  nombre: ["nombre de persona de interes", "nombre persona de interes", "nombre", "colaborador"],
  // "punto_venta" cubre el formato antiguo/alternativo donde el nombre del
  // PDV viene en su propia columna de texto plano.
  punto_venta: ["punto de venta", "pdv", "sucursal", "ubicacion"],
  // "id_punto_venta" cubre el formato REAL del sistema de marcaciones: la
  // columna "Identificador de Punto de Interés" trae el código del PDV
  // (ej. "PDV0347"), vacío en filas de Descanso/Traslado.
  id_punto_venta: ["identificador de punto de interes", "id de punto de venta", "id pdv", "codigo pdv"],
  actividad: ["actividad", "tipo de actividad", "tarea"],
  fecha: ["fecha", "dia"],
  hora_inicio: ["hora inicio", "hora de inicio", "hora entrada"],
  hora_salida: ["hora salida", "hora de salida", "hora fin"],
  tiempo_transcurrido: ["tiempo transcurrido", "duracion", "tiempo"],
};

function normalizarTexto(txt) {
  if (typeof txt !== "string") return "";
  let t = txt.trim().toLowerCase();
  const reemplazos = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ñ: "n" };
  for (const [a, b] of Object.entries(reemplazos)) t = t.split(a).join(b);
  return t.replace(/\s+/g, " ");
}

function mapearColumnas(columnas) {
  const normalizados = columnas.map((c) => [c, normalizarTexto(c)]);
  const mapeo = {};
  for (const [estandar, aliasList] of Object.entries(COLUMN_ALIASES)) {
    let encontrado = null;
    for (const [colOriginal, colNorm] of normalizados) {
      if (aliasList.includes(colNorm) || aliasList.some((a) => colNorm.includes(a))) {
        encontrado = colOriginal;
        break;
      }
    }
    if (encontrado) mapeo[estandar] = encontrado;
  }
  const faltantes = ["id_empleado", "nombre", "fecha", "hora_inicio"].filter((k) => !mapeo[k]);
  if (faltantes.length) {
    throw new Error(
      `No se pudieron identificar columnas obligatorias en el Excel: ${faltantes.join(", ")}. ` +
        `Columnas disponibles: ${columnas.join(", ")}`
    );
  }
  return mapeo;
}

function limpiarString(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  return String(valor).trim();
}

// Parsea DD/MM/YY, DD/MM/YYYY, o fecha serial de Excel -> string "YYYY-MM-DD"
function parsearFecha(valor) {
  if (valor === null || valor === undefined || valor === "") return null;

  // Fecha serial de Excel (número)
  if (typeof valor === "number") {
    const fecha = XLSX.SSF.parse_date_code(valor);
    if (!fecha) return null;
    return `${fecha.y.toString().padStart(4, "0")}-${String(fecha.m).padStart(2, "0")}-${String(fecha.d).padStart(2, "0")}`;
  }

  const str = String(valor).trim();
  // DD/MM/YY o DD/MM/YYYY o DD-MM-YYYY
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    d = parseInt(d, 10);
    mo = parseInt(mo, 10);
    y = parseInt(y, 10);
    if (y < 100) y += 2000; // asume siglo 21 para años de 2 dígitos
    return `${y.toString().padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // YYYY-MM-DD ya viene bien
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

// Normaliza una hora (texto, Date, o fracción de día de Excel) a "HH:MM". Null si "-" o vacío.
function horaATexto(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "string") {
    const v = valor.trim();
    if (["-", "", "N/A", "nan"].includes(v)) return null;
    return v;
  }
  if (typeof valor === "number") {
    // fracción de día de Excel
    const totalMin = Math.round(valor * 24 * 60);
    const h = Math.floor(totalMin / 60) % 24;
    const m = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  if (valor instanceof Date) {
    return `${String(valor.getHours()).padStart(2, "0")}:${String(valor.getMinutes()).padStart(2, "0")}`;
  }
  return String(valor).trim();
}

// Convierte "HH:MM" (o número fracción de día) a minutos enteros. Null si "-" (marcación abierta).
function duracionAMinutos(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "string") {
    const v = valor.trim();
    if (["-", "", "N/A", "nan"].includes(v)) return null;
    const m = v.match(/^(\d{1,3}):(\d{2})(:\d{2})?$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const num = parseFloat(v);
    return isNaN(num) ? null : num;
  }
  if (typeof valor === "number") {
    return Math.round(valor * 24 * 60);
  }
  return null;
}

/**
 * Lee un ArrayBuffer de un archivo .xlsx y devuelve:
 *   { filas, meta }
 * - filas: array de objetos limpios { id_empleado, nombre, punto_venta,
 *   actividad, fecha, hora_inicio, hora_salida, tiempo_transcurrido_min,
 *   marcacion_abierta, periodo }
 * - meta: estadísticas de calidad de datos para mostrar en el resumen de
 *   carga { hojaUsada, filasTotalesHoja, filasValidas, filasDescartadas,
 *   duplicadosDetectados, fechasInvalidas, horasInvalidas }
 */
function leerYLimpiarExcel(arrayBuffer, hojaPreferida = "actividad") {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const hojaReal =
    wb.SheetNames.find((s) => normalizarTexto(s) === hojaPreferida) || wb.SheetNames[0];
  const ws = wb.Sheets[hojaReal];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });

  const meta = {
    hojaUsada: hojaReal,
    filasTotalesHoja: rawRows.length,
    filasValidas: 0,
    filasDescartadas: 0,
    duplicadosDetectados: 0,
    fechasInvalidas: 0,
    horasInvalidas: 0,
  };

  if (!rawRows.length) return { filas: [], meta };

  const columnas = Object.keys(rawRows[0]);
  const mapeo = mapearColumnas(columnas);

  // Columnas opcionales no detectadas: si el Excel real usa un encabezado
  // distinto a los previstos en COLUMN_ALIASES, esa columna queda vacía en
  // TODAS las filas sin lanzar ningún error (por diseño, para no romper la
  // carga por una columna secundaria) — pero eso puede producir resultados
  // silenciosamente incorrectos (ej. "PDV visitados por día: 0.0" si nunca
  // se detectó ni "Punto de Venta" ni "Identificador de Punto de Interés").
  // Se reporta para que el usuario lo note.
  const tienePuntoVenta = !!(mapeo.punto_venta || mapeo.id_punto_venta);
  const columnasOpcionalesEsperadas = {
    actividad: "Actividad",
    hora_salida: "Hora de salida",
    tiempo_transcurrido: "Tiempo transcurrido",
  };
  meta.columnasOpcionalesNoDetectadas = Object.entries(columnasOpcionalesEsperadas)
    .filter(([clave]) => !mapeo[clave])
    .map(([, nombre]) => nombre);
  if (!tienePuntoVenta) meta.columnasOpcionalesNoDetectadas.push("Punto de Venta / Identificador de Punto de Interés");

  const filas = [];
  const clavesVistas = new Set();

  for (const row of rawRows) {
    const id_empleado = limpiarString(row[mapeo.id_empleado]);
    const fechaCruda = row[mapeo.fecha];
    const fecha = parsearFecha(fechaCruda);

    // Fila totalmente vacía (sin id ni fecha): se descarta en silencio, no
    // cuenta como "inválida" porque probablemente es una fila en blanco del
    // Excel, no un dato real con un problema.
    if (!id_empleado && (fechaCruda === null || fechaCruda === undefined || fechaCruda === "")) {
      meta.filasDescartadas += 1;
      continue;
    }

    if (fechaCruda && !fecha) {
      meta.fechasInvalidas += 1;
      meta.filasDescartadas += 1;
      continue;
    }
    if (!id_empleado || !fecha) {
      meta.filasDescartadas += 1;
      continue;
    }

    const nombre = limpiarString(row[mapeo.nombre]);

    // --- Punto de venta / actividad ---
    // Formato REAL del sistema: la columna "Identificador de Punto de
    // Interés" trae el código del PDV (ej. "PDV0347"), y la columna
    // "Actividad" trae "{identificador} - {nombre del PDV}" (ej.
    // "PDV0347 - JOBS OFICINA"); para Descanso/Traslado, el identificador
    // viene vacío y "Actividad" trae directamente "Descanso"/"Traslado".
    // El identificador NO siempre empieza con "PDV" (a veces es el propio
    // nombre del local), así que se le quita como prefijo literal en vez de
    // buscar un patrón fijo.
    const idPuntoVentaCrudo = mapeo.id_punto_venta ? limpiarString(row[mapeo.id_punto_venta]) : null;
    const actividadCruda = mapeo.actividad ? limpiarString(row[mapeo.actividad]) : null;

    let punto_venta = null;
    let id_punto_venta = null;
    let actividad;

    if (idPuntoVentaCrudo) {
      // Es una visita a PDV: el identificador viene informado.
      id_punto_venta = idPuntoVentaCrudo;
      actividad = "PDV";
      const prefijo = `${idPuntoVentaCrudo} -`;
      if (actividadCruda && actividadCruda.startsWith(prefijo)) {
        punto_venta = actividadCruda.slice(prefijo.length).trim();
      } else {
        punto_venta = actividadCruda || idPuntoVentaCrudo;
      }
    } else if (mapeo.punto_venta) {
      // Formato alternativo: nombre de PDV en su propia columna de texto.
      punto_venta = limpiarString(row[mapeo.punto_venta]);
      actividad = actividadCruda || "PDV";
    } else {
      // Sin identificador ni columna de punto de venta: Descanso/Traslado u
      // otra actividad sin PDV asociado.
      actividad = actividadCruda || "PDV";
    }

    const horaInicioCruda = row[mapeo.hora_inicio];
    const hora_inicio = horaATexto(horaInicioCruda);
    if (horaInicioCruda && !hora_inicio) meta.horasInvalidas += 1;

    const hora_salida = mapeo.hora_salida ? horaATexto(row[mapeo.hora_salida]) : null;
    const tiempo_transcurrido_min = mapeo.tiempo_transcurrido
      ? duracionAMinutos(row[mapeo.tiempo_transcurrido])
      : null;

    // Detección de registros duplicados exactos (misma persona, fecha, hora
    // de inicio y punto de venta). Se conservan igual —no se eliminan— pero
    // se cuentan para advertir al usuario.
    const claveDuplicado = `${id_empleado}|${fecha}|${hora_inicio}|${punto_venta}`;
    if (clavesVistas.has(claveDuplicado)) meta.duplicadosDetectados += 1;
    clavesVistas.add(claveDuplicado);

    const [y, mo] = fecha.split("-");
    filas.push({
      id_empleado,
      nombre,
      punto_venta,
      id_punto_venta,
      actividad,
      fecha,
      hora_inicio,
      hora_salida,
      tiempo_transcurrido_min,
      marcacion_abierta: hora_salida === null,
      periodo: `${y}-${mo}`,
    });
  }
  meta.filasValidas = filas.length;
  return { filas, meta };
}

function detectarPeriodo(filas) {
  if (!filas.length) return null;
  const conteo = {};
  for (const f of filas) conteo[f.periodo] = (conteo[f.periodo] || 0) + 1;
  return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
}

// ============================================================================
// RUTAS ASIGNADAS — archivo aparte (catálogo, no cambia mes a mes) con las
// visitas obligatorias por colaborador y día de la semana.
//
// Formato esperado (según la hoja real compartida por el usuario):
//   Hoja 1: Cliente | Persona de Interés | Punto de venta | Visita | Identificador
//     - "Visita" trae códigos de día separados por coma: LU, MA, MI, JU, VI, SA.
//     - Si "Visita" viene vacía, esa fila NO genera ninguna obligación — se
//       ignora por completo para efectos de cumplimiento (solo se mide lo que
//       la persona efectivamente visitó, sin exigirle nada ahí).
//   Hoja 2 (opcional): catálogo completo Nombre | Identificador — no se usa
//     para el cálculo de cumplimiento (se compara por nombre de PDV contra el
//     Excel de marcaciones), pero se lee por si en el futuro hace falta.
// ============================================================================

const DIAS_VALIDOS = new Set(["LU", "MA", "MI", "JU", "VI", "SA", "DO"]);

const COLUMN_ALIASES_RUTAS = {
  cliente: ["cliente"],
  persona: ["persona de interes", "persona de interés", "nombre", "colaborador"],
  punto_venta: ["punto de venta", "pdv", "punto venta"],
  visita: ["visita", "dias", "días", "dia", "día"],
  identificador: ["identificador", "id pdv", "codigo", "código"],
};

function mapearColumnasRutas(columnas) {
  const normalizados = columnas.map((c) => [c, normalizarTexto(c)]);
  const mapeo = {};
  for (const [estandar, aliasList] of Object.entries(COLUMN_ALIASES_RUTAS)) {
    let encontrado = null;
    for (const [colOriginal, colNorm] of normalizados) {
      if (aliasList.includes(colNorm) || aliasList.some((a) => colNorm.includes(a))) {
        encontrado = colOriginal;
        break;
      }
    }
    if (encontrado) mapeo[estandar] = encontrado;
  }
  return mapeo;
}

// Normaliza un nombre de persona para poder cruzarlo entre dos archivos
// distintos (mayúsculas/minúsculas y espacios pueden variar entre el Excel
// de marcaciones y la hoja de rutas asignadas).
function normalizarNombrePersona(nombre) {
  return String(nombre || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parsearDiasVisita(valor) {
  if (valor === null || valor === undefined) return [];
  const texto = String(valor).trim();
  if (!texto) return [];
  // Se separa por cualquier caracter que NO sea una letra (coma, punto,
  // espacio, punto y coma, barra...) en vez de solo por coma: la hoja real
  // trae errores de tipeo como "LU,MI.VI" (punto en vez de coma) o
  // "VI SA" (falta la coma), y de este modo igual se interpretan bien.
  return texto
    .split(/[^A-Za-zÁÉÍÓÚáéíóúÑñ]+/)
    .map((d) => d.trim().toUpperCase())
    .filter((d) => DIAS_VALIDOS.has(d));
}

/**
 * Lee el archivo de rutas asignadas y devuelve:
 *   { asignaciones, meta }
 * - asignaciones: array de { cliente, persona, nombre_normalizado,
 *   punto_venta, dias: string[], identificador }. Las filas con "Visita"
 *   vacía SÍ se incluyen (con dias: []) para que quede constancia de que la
 *   persona tiene ese PDV listado, aunque no genere obligación por día.
 * - meta: { hojaUsada, filasTotalesHoja, filasValidas, filasSinDia }
 */
// Núcleo de la lectura, independiente de si el origen fue un archivo .xlsx
// o texto CSV descargado en vivo desde Google Sheets — ambos se convierten
// primero en un WorkBook de SheetJS y de ahí en adelante es la misma lógica.
function leerRutasAsignadasDesdeWorkbook(wb) {
  const hojaReal = wb.SheetNames[0];
  const ws = wb.Sheets[hojaReal];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });

  const meta = { hojaUsada: hojaReal, filasTotalesHoja: rawRows.length, filasValidas: 0, filasSinDia: 0 };
  if (!rawRows.length) return { asignaciones: [], meta };

  const columnas = Object.keys(rawRows[0]);
  const mapeo = mapearColumnasRutas(columnas);
  const faltantes = ["persona", "punto_venta"].filter((k) => !mapeo[k]);
  if (faltantes.length) {
    throw new Error(
      `No se pudieron identificar columnas obligatorias en el archivo de rutas: ${faltantes.join(", ")}. ` +
        `Columnas disponibles: ${columnas.join(", ")}`
    );
  }

  const asignaciones = [];
  for (const row of rawRows) {
    const persona = row[mapeo.persona] ? String(row[mapeo.persona]).trim() : null;
    const puntoVenta = row[mapeo.punto_venta] ? String(row[mapeo.punto_venta]).trim() : null;
    if (!persona || !puntoVenta) continue;

    const dias = mapeo.visita ? parsearDiasVisita(row[mapeo.visita]) : [];
    if (!dias.length) meta.filasSinDia += 1;

    const identificador = mapeo.identificador ? String(row[mapeo.identificador] || "").trim() : null;
    asignaciones.push({
      cliente: mapeo.cliente ? String(row[mapeo.cliente] || "").trim() : null,
      persona,
      nombre_normalizado: normalizarNombrePersona(persona),
      punto_venta: puntoVenta,
      // Clave de cruce contra lo efectivamente visitado: se prioriza el
      // identificador (ej. "PDV0001", igual al que trae el Excel de
      // marcaciones en "Identificador de Punto de Interés") por ser más
      // confiable que el nombre; si no hay identificador, cae al nombre
      // normalizado como respaldo.
      clave_pdv: identificador ? identificador.toLowerCase() : normalizarNombrePersona(puntoVenta),
      dias,
      identificador,
    });
  }
  meta.filasValidas = asignaciones.length;
  return { asignaciones, meta };
}

function leerRutasAsignadas(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  return leerRutasAsignadasDesdeWorkbook(wb);
}

// Para sincronización en vivo: el texto ya viene como CSV (respuesta de
// fetch() a la URL de exportación pública de Google Sheets). SheetJS puede
// parsear CSV directamente como si fuera un libro de un solo hoja.
function leerRutasAsignadasDesdeCSV(textoCSV) {
  const wb = XLSX.read(textoCSV, { type: "string" });
  return leerRutasAsignadasDesdeWorkbook(wb);
}

// Exporta para uso en Node (pruebas) y en navegador (script clásico)
if (typeof module !== "undefined") {
  module.exports = {
    leerYLimpiarExcel,
    detectarPeriodo,
    parsearFecha,
    duracionAMinutos,
    horaATexto,
    normalizarTexto,
    leerRutasAsignadas,
    leerRutasAsignadasDesdeCSV,
    normalizarNombrePersona,
    parsearDiasVisita,
  };
}
