// ============================================================================
// reportsClient.js — Generación de reportes en el navegador
// Usa las librerías globales XLSX (SheetJS) y jspdf + jspdf-autotable (CDN).
// Usa la MISMA función central de clasificación y el mismo formateador de
// minutos que el resto del dashboard (businessLogic.js), para que Excel y
// PDF sean consistentes con las tarjetas, la tabla y los gráficos.
// ============================================================================

function descargarBlob(blob, nombreArchivo) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * @param {Array} resumenes - filas de asistencia_resumen_diario con `nombre` incluido (ya filtradas por la UI)
 * @param {Array} marcaciones - filas de marcaciones_detalle con `nombre` incluido, del/los periodo(s) completo(s)
 * @param {string} etiquetaPeriodo - usado solo para el nombre del archivo
 * @param {Object} meta - { periodoTexto, filtros: {colaboradores, estados, rango}, limiteDescanso }
 */
function exportarExcelConsolidado(resumenes, marcaciones, etiquetaPeriodo, meta) {
  meta = meta || {};
  // ---- Hoja "Información": período, filtros aplicados y fecha de generación ----
  const infoFilas = [
    { Campo: "Período analizado", Valor: meta.periodoTexto || "—" },
    { Campo: "Colaboradores (filtro)", Valor: (meta.filtros && meta.filtros.colaboradores) || "Todos los colaboradores" },
    { Campo: "Estados (filtro)", Valor: (meta.filtros && meta.filtros.estados) || "Todos los estados" },
    { Campo: "Rango de fechas (filtro)", Valor: (meta.filtros && meta.filtros.rango) || "Sin restricción de fecha" },
    { Campo: "Fecha y hora de generación", Valor: new Date().toLocaleString("es-ES") },
    { Campo: "Nota", Valor: "La hoja 'Marcaciones Detalle' incluye todas las marcaciones del período completo, sin aplicar los filtros de colaborador/estado/fecha (respaldo de auditoría)." },
  ];

  // ---- Hoja 1: Resumen Ejecutivo por Empleado (agregado del período filtrado) ----
  const porEmpleado = new Map();
  for (const r of resumenes) {
    const key = r.id_empleado;
    if (!porEmpleado.has(key)) {
      porEmpleado.set(key, {
        "ID Empleado": r.id_empleado,
        "Nombre": r.nombre,
        "Dias_Trabajados": new Set(),
        "Cantidad_Tardanzas": 0,
        "Cantidad_Tardanzas_Leves": 0,
        "Cantidad_Tardanzas_Supervisar": 0,
        "Minutos_Acumulados_Tardanza": 0,
        "Minutos_PDV": 0,
        "Minutos_Traslado": 0,
        "Exceso_Descanso_Total_Min": 0,
        "Dias_Sin_Entrada": 0,
      });
    }
    const acc = porEmpleado.get(key);
    acc.Dias_Trabajados.add(r.fecha);
    if (esTardanza(r.clasificacion_puntualidad)) {
      acc.Cantidad_Tardanzas += 1;
      acc.Minutos_Acumulados_Tardanza += r.minutos_tardanza || 0;
    }
    if (r.clasificacion_puntualidad === ESTADOS.LEVE) acc.Cantidad_Tardanzas_Leves += 1;
    if (r.clasificacion_puntualidad === ESTADOS.SUPERVISAR) acc.Cantidad_Tardanzas_Supervisar += 1;
    if (r.clasificacion_puntualidad === ESTADOS.SIN_ENTRADA) acc.Dias_Sin_Entrada += 1;
    acc.Minutos_PDV += r.minutos_pdv || 0;
    acc.Minutos_Traslado += r.minutos_traslado || 0;
    acc.Exceso_Descanso_Total_Min += r.minutos_exceso_descanso || 0;
  }
  const resumenEjecutivo = [...porEmpleado.values()].map((r) => ({
    "ID Empleado": r["ID Empleado"],
    "Nombre": r["Nombre"],
    "Días Trabajados": r.Dias_Trabajados.size,
    "Cantidad de Tardanzas": r.Cantidad_Tardanzas,
    "Tardanzas Leves": r.Cantidad_Tardanzas_Leves,
    "Tardanzas a Supervisar": r.Cantidad_Tardanzas_Supervisar,
    "Minutos Acumulados de Tardanza": r.Minutos_Acumulados_Tardanza,
    "Horas PDV": Math.round((r.Minutos_PDV / 60) * 10) / 10,
    "Horas Traslado": Math.round((r.Minutos_Traslado / 60) * 10) / 10,
    "Exceso Descanso Total (min)": r.Exceso_Descanso_Total_Min,
    "Días Sin Entrada": r.Dias_Sin_Entrada,
  }));

  // ---- Hoja 2: Detalle Diario (valores numéricos con unidad aclarada en el encabezado) ----
  const detalleDiario = resumenes.map((r) => ({
    "ID Empleado": r.id_empleado,
    "Nombre": r.nombre,
    "Fecha": r.fecha,
    "Entrada": r.primer_checkin,
    "Salida": r.ultimo_checkout,
    "Estado": r.clasificacion_puntualidad,
    "Minutos desde las 08:00": r.minutos_tardanza,
    "Descanso (min)": r.minutos_descanso_total,
    "Exceso Descanso (min)": r.minutos_exceso_descanso,
    "Minutos Trabajados (bruto)": r.minutos_trabajados,
    "Horas Efectivas (min)": r.minutos_efectivos,
    "Cumplió Jornada": r.minutos_efectivos === null ? "—" : r.cumplio_jornada ? "Sí" : "No",
    "PDVs Esperados (ruta asignada)": r.ruta_pdvs_esperados ? r.ruta_pdvs_esperados.join("; ") : "—",
    "Ruta Cumplida": r.ruta_cumplida === null || r.ruta_cumplida === undefined ? "Sin ruta asignada" : r.ruta_cumplida ? "Sí" : "No",
    "PDVs Faltantes": r.ruta_pdvs_faltantes && r.ruta_pdvs_faltantes.length ? r.ruta_pdvs_faltantes.join("; ") : "—",
    "Minutos PDV": r.minutos_pdv,
    "Minutos Traslado": r.minutos_traslado,
    "PDVs Únicos": r.pdvs_unicos_visitados,
    "PDVs Visitados": r.lista_pdvs,
    "Marcación Abierta": r.tiene_marcacion_abierta ? "Sí" : "No",
    "Inconsistencias": (r.inconsistencias || []).join("; ") || "—",
  }));

  // ---- Hoja 3: Inconsistencias ----
  const inconsistencias = detalleDiario.filter(
    (r) => r["Marcación Abierta"] === "Sí" || r["Inconsistencias"] !== "—" || r["Exceso Descanso (min)"] > 0
  );

  // ---- Hoja 4: Marcaciones fila a fila (SIEMPRE el período completo, sin filtros de UI) ----
  const detalleMarcaciones = marcaciones.map((m) => ({
    "ID Empleado": m.id_empleado,
    "Nombre": m.nombre,
    "Fecha": m.fecha,
    "Punto de Venta": m.punto_venta,
    "Actividad": m.actividad,
    "Hora Inicio": m.hora_inicio,
    "Hora Salida": m.hora_salida || "Sin cierre",
    "Duración (min)": m.tiempo_transcurrido_min,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(infoFilas), "Información");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(resumenEjecutivo.length ? resumenEjecutivo : [{ Info: "Sin datos para el período/filtros seleccionados" }]),
    "Resumen Ejecutivo"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(detalleDiario.length ? detalleDiario : [{ Info: "Sin datos" }]),
    "Detalle Diario"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(inconsistencias.length ? inconsistencias : [{ Info: "Sin inconsistencias" }]),
    "Inconsistencias"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(detalleMarcaciones.length ? detalleMarcaciones : [{ Info: "Sin datos" }]),
    "Marcaciones Detalle"
  );

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/octet-stream" });
  descargarBlob(blob, `Consolidado_Asistencia_${etiquetaPeriodo}.xlsx`);
}

/**
 * @param {Array} registrosDelDia - filas de asistencia_resumen_diario (con `nombre`) de una sola fecha
 * @param {string} fecha - "YYYY-MM-DD"
 * @param {number} limiteDescanso - límite de descanso permitido (min), para mostrar el exceso con claridad
 */
function exportarPdfResumenDiario(registrosDelDia, fecha, limiteDescanso) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "cm", format: "letter" });
  const azul = [14, 26, 46]; // #0E1A2E, ink navy
  const [y, m, d] = fecha.split("-");

  doc.setFontSize(16);
  doc.setTextColor(...azul);
  doc.text("Ficha Ejecutiva Diaria — Control de Asistencia y Rutas", 1.2, 1.3);
  doc.setFontSize(10);
  doc.setTextColor(120, 120, 120);
  doc.text(`Fecha: ${d}/${m}/${y}  ·  Generado el ${new Date().toLocaleString("es-ES")}`, 1.2, 1.9);

  if (!registrosDelDia.length) {
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(11);
    doc.text("No hay registros de asistencia para esta fecha.", 1.2, 2.8);
    doc.save(`Ficha_Diaria_${fecha}.pdf`);
    return;
  }

  const total = registrosDelDia.length;
  const puntuales = registrosDelDia.filter((r) => r.clasificacion_puntualidad === ESTADOS.PUNTUAL).length;
  const leves = registrosDelDia.filter((r) => r.clasificacion_puntualidad === ESTADOS.LEVE).length;
  const supervisar = registrosDelDia.filter((r) => r.clasificacion_puntualidad === ESTADOS.SUPERVISAR).length;
  const sinEntrada = registrosDelDia.filter((r) => r.clasificacion_puntualidad === ESTADOS.SIN_ENTRADA).length;

  doc.autoTable({
    startY: 2.3,
    head: [["Colaboradores", "Puntuales", "Tardanza Leve", "Tardanza a Supervisar", "Sin Entrada"]],
    body: [[total, puntuales, leves, supervisar, sinEntrada]],
    theme: "grid",
    headStyles: { fillColor: azul, halign: "center" },
    bodyStyles: { halign: "center", fontSize: 9 },
    margin: { left: 1.2, right: 1.2 },
  });

  const ordenados = [...registrosDelDia].sort((a, b) => a.nombre.localeCompare(b.nombre));
  const filas = ordenados.map((r) => {
    let ruta = r.lista_pdvs || "—";
    if (ruta.length > 32) ruta = ruta.slice(0, 29) + "...";
    const salidaTexto = r.ultimo_checkout || (r.tiene_marcacion_abierta ? "Abierta" : "—");
    return [
      r.nombre,
      r.primer_checkin || "—",
      salidaTexto,
      r.clasificacion_puntualidad,
      formatMinutos(r.minutos_tardanza),
      formatDescanso(r.minutos_descanso_total, limiteDescanso),
      r.minutos_efectivos === null ? "—" : `${formatHorasTrabajadas(r.minutos_efectivos)}${r.cumplio_jornada ? "" : " ⚠"}`,
      r.pdvs_unicos_visitados ?? 0,
      ruta,
    ];
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 0.6,
    head: [["Colaborador", "Entrada", "Salida", "Estado", "Min. desde las 08:00", "Descanso (min)", "Horas efectivas", "PDV", "Ruta"]],
    body: filas,
    theme: "grid",
    headStyles: { fillColor: azul, fontSize: 7.5 },
    bodyStyles: { fontSize: 7 },
    margin: { left: 1.2, right: 1.2 },
    didParseCell: function (data) {
      if (data.section !== "body") return;
      const row = ordenados[data.row.index];
      if (!row) return;
      if (row.clasificacion_puntualidad === ESTADOS.SUPERVISAR || row.tiene_marcacion_abierta) {
        data.cell.styles.fillColor = [251, 228, 228]; // #FBE4E4, bad-soft
      } else if (row.clasificacion_puntualidad === ESTADOS.LEVE || row.alerta_exceso_descanso) {
        data.cell.styles.fillColor = [251, 238, 221]; // #FBEEDD, warn-soft
      } else if (row.clasificacion_puntualidad === ESTADOS.PUNTUAL) {
        data.cell.styles.fillColor = [225, 243, 232]; // #E1F3E8, ok-soft
      }
    },
  });

  // --- Sección de inconsistencias del día ---
  const conInconsistencia = ordenados.filter((r) => r.tiene_inconsistencia);
  if (conInconsistencia.length) {
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 0.6,
      head: [["Inconsistencias detectadas (no se eliminan, quedan marcadas para revisión)"]],
      body: conInconsistencia.map((r) => [`${r.nombre}: ${(r.inconsistencias || []).join("; ")}`]),
      theme: "grid",
      headStyles: { fillColor: [210, 75, 75], fontSize: 8 }, // #D24B4B, bad
      bodyStyles: { fontSize: 7.5 },
      margin: { left: 1.2, right: 1.2 },
    });
  }

  doc.setFontSize(8);
  doc.setTextColor(140, 140, 140);
  doc.text(
    `Sistema de Control de Asistencia y Gestión de Rutas PDV — todas las duraciones se expresan en minutos.`,
    1.2,
    doc.internal.pageSize.getHeight() - 1
  );

  doc.save(`Ficha_Diaria_${fecha}.pdf`);
}
