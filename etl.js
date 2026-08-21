// ============================================================================
// etl.js — Lectura y limpieza del Excel "en bruto" de marcaciones
// Misma lógica que la versión Python (core/etl.py), reescrita en JS puro
// para correr 100% en el navegador (usa SheetJS ya cargado como `XLSX`).
// ============================================================================

const COLUMN_ALIASES = {
  id_empleado: ["id de persona de interes", "id persona de interes", "id empleado", "cedula", "documento", "id"],
  nombre: ["nombre de persona de interes", "nombre persona de interes", "nombre", "colaborador"],
  punto_venta: ["punto de venta", "pdv", "sucursal", "ubicacion"],
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
 * Lee un ArrayBuffer de un archivo .xlsx y devuelve un array de objetos limpios:
 * { id_empleado, nombre, punto_venta, actividad, fecha, hora_inicio, hora_salida,
 *   tiempo_transcurrido_min, marcacion_abierta, periodo }
 */
function leerYLimpiarExcel(arrayBuffer, hojaPreferida = "actividad") {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const hojaReal =
    wb.SheetNames.find((s) => normalizarTexto(s) === hojaPreferida) || wb.SheetNames[0];
  const ws = wb.Sheets[hojaReal];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });

  if (!rawRows.length) return [];

  const columnas = Object.keys(rawRows[0]);
  const mapeo = mapearColumnas(columnas);

  const filas = [];
  for (const row of rawRows) {
    const id_empleado = limpiarString(row[mapeo.id_empleado]);
    const fecha = parsearFecha(row[mapeo.fecha]);
    if (!id_empleado || !fecha) continue; // descarta filas vacías/incompletas

    const nombre = limpiarString(row[mapeo.nombre]);
    const punto_venta = mapeo.punto_venta ? limpiarString(row[mapeo.punto_venta]) : null;
    const actividad = mapeo.actividad ? limpiarString(row[mapeo.actividad]) || "PDV" : "PDV";
    const hora_inicio = horaATexto(row[mapeo.hora_inicio]);
    const hora_salida = mapeo.hora_salida ? horaATexto(row[mapeo.hora_salida]) : null;
    const tiempo_transcurrido_min = mapeo.tiempo_transcurrido
      ? duracionAMinutos(row[mapeo.tiempo_transcurrido])
      : null;

    const [y, mo] = fecha.split("-");
    filas.push({
      id_empleado,
      nombre,
      punto_venta,
      actividad,
      fecha,
      hora_inicio,
      hora_salida,
      tiempo_transcurrido_min,
      marcacion_abierta: hora_salida === null,
      periodo: `${y}-${mo}`,
    });
  }
  return filas;
}

function detectarPeriodo(filas) {
  if (!filas.length) return null;
  const conteo = {};
  for (const f of filas) conteo[f.periodo] = (conteo[f.periodo] || 0) + 1;
  return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
}

// Exporta para uso en Node (pruebas) y en navegador (script clásico)
if (typeof module !== "undefined") {
  module.exports = { leerYLimpiarExcel, detectarPeriodo, parsearFecha, duracionAMinutos, horaATexto, normalizarTexto };
}
