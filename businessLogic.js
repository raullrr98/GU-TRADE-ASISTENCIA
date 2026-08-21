// ============================================================================
// businessLogic.js — Cálculo de asistencia_resumen_diario a partir de las
// filas limpias que produce etl.js. Misma lógica que core/business_logic.py.
// ============================================================================

const ACTIVIDADES_DESCANSO = new Set(["descanso", "break", "almuerzo"]);
const ACTIVIDADES_TRASLADO = new Set(["traslado", "transporte", "movilizacion", "movilización"]);

function norm(txt) {
  return txt ? String(txt).trim().toLowerCase() : "";
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

function clasificarPuntualidad(minutosTardanza, huboEntrada, tolerancia, tardanzaLeveMax) {
  if (!huboEntrada) return "Sin Entrada";
  if (minutosTardanza <= tolerancia) return "Puntual";
  const tardanzaEfectiva = minutosTardanza - tolerancia;
  return tardanzaEfectiva <= tardanzaLeveMax ? "Tardanza Leve" : "Tardanza Grave";
}

/**
 * Agrupa las filas limpias por (empleado, fecha) y calcula, para cada grupo,
 * el resumen diario de asistencia. Devuelve un array de objetos listos para
 * guardar en la tabla asistencia_resumen_diario.
 *
 * @param {Array} filas - salida de etl.leerYLimpiarExcel()
 * @param {Object} config - { horaEntradaTeorica: "08:00", toleranciaMin: 10,
 *                            tardanzaLeveMaxMin: 15, descansoPermitidoMin: 60 }
 */
function calcularResumen(filas, config) {
  const horaEntradaTeoMin = horaAMinutos(config.horaEntradaTeorica) ?? 480;
  const tolerancia = config.toleranciaMin ?? 10;
  const tardanzaLeveMax = config.tardanzaLeveMaxMin ?? 15;
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
    let minutosTardanza = 0;
    if (huboEntrada) {
      const minCheckin = horaAMinutos(primerCheckin);
      if (minCheckin !== null) minutosTardanza = Math.max(0, minCheckin - horaEntradaTeoMin);
    }
    const clasificacion = clasificarPuntualidad(minutosTardanza, huboEntrada, tolerancia, tardanzaLeveMax);

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

    // Secuencia ordenada cronológicamente (para dibujar la línea de ruta),
    // colapsando visitas consecutivas al mismo PDV.
    const secuenciaCruda = ordenadas
      .filter((f) => f.punto_venta && !ACTIVIDADES_DESCANSO.has(norm(f.actividad)) && !ACTIVIDADES_TRASLADO.has(norm(f.actividad)))
      .map((f) => f.punto_venta);
    const pdvsSecuencia = secuenciaCruda.filter((pdv, i) => pdv !== secuenciaCruda[i - 1]);

    const tieneAbierta = ordenadas.some((f) => f.marcacion_abierta);
    const [y, mo] = fecha.split("-");

    resumenes.push({
      id_empleado,
      fecha,
      periodo: `${y}-${mo}`,
      primer_checkin: primerCheckin,
      ultimo_checkout: ultimoCheckout,
      minutos_tardanza: minutosTardanza,
      clasificacion_puntualidad: clasificacion,
      minutos_descanso_total: minutosDescanso,
      minutos_exceso_descanso: excesoDescanso,
      alerta_exceso_descanso: excesoDescanso > 0,
      minutos_pdv: minutosPdv,
      minutos_traslado: minutosTraslado,
      pdvs_unicos_visitados: pdvsVisitados.size,
      lista_pdvs: pdvsVisitados.size ? [...pdvsVisitados].sort().join("; ") : null,
      pdvs_secuencia: pdvsSecuencia,
      tiene_marcacion_abierta: tieneAbierta,
    });
  }
  return resumenes;
}

if (typeof module !== "undefined") {
  module.exports = { calcularResumen, clasificarPuntualidad, horaAMinutos };
}
