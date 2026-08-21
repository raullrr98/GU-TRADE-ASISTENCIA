// ============================================================================
// reportsClient.js — Generación de reportes en el navegador
// Usa las librerías globales XLSX (SheetJS) y jspdf + jspdf-autotable (CDN).
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
 * @param {Array} resumenes - filas de asistencia_resumen_diario con `nombre` incluido, del periodo elegido
 * @param {Array} marcaciones - filas de marcaciones_detalle con `nombre` incluido, del periodo elegido
 * @param {string} periodo - "YYYY-MM"
 */
function exportarExcelConsolidado(resumenes, marcaciones, periodo) {
  // ---- Hoja 1: Resumen Ejecutivo por Empleado (agregado del mes) ----
  const porEmpleado = new Map();
  for (const r of resumenes) {
    const key = r.id_empleado;
    if (!porEmpleado.has(key)) {
      porEmpleado.set(key, {
        "ID Empleado": r.id_empleado,
        "Nombre": r.nombre,
        "Dias_Trabajados": new Set(),
        "Total_Tardanzas": 0,
        "Tardanzas_Graves": 0,
        "Minutos_Tardanza_Acumulados": 0,
        "Minutos_PDV": 0,
        "Minutos_Traslado": 0,
        "Exceso_Descanso_Total_Min": 0,
        "Dias_Sin_Entrada": 0,
      });
    }
    const acc = porEmpleado.get(key);
    acc.Dias_Trabajados.add(r.fecha);
    if (r.clasificacion_puntualidad !== "Puntual" && r.clasificacion_puntualidad !== "Sin Entrada") {
      acc.Total_Tardanzas += 1;
    }
    if (r.clasificacion_puntualidad === "Tardanza Grave") acc.Tardanzas_Graves += 1;
    if (r.clasificacion_puntualidad === "Sin Entrada") acc.Dias_Sin_Entrada += 1;
    acc.Minutos_Tardanza_Acumulados += r.minutos_tardanza || 0;
    acc.Minutos_PDV += r.minutos_pdv || 0;
    acc.Minutos_Traslado += r.minutos_traslado || 0;
    acc.Exceso_Descanso_Total_Min += r.minutos_exceso_descanso || 0;
  }
  const resumenEjecutivo = [...porEmpleado.values()].map((r) => ({
    "ID Empleado": r["ID Empleado"],
    "Nombre": r["Nombre"],
    "Dias Trabajados": r.Dias_Trabajados.size,
    "Total Tardanzas": r.Total_Tardanzas,
    "Tardanzas Graves": r.Tardanzas_Graves,
    "Minutos Tardanza Acumulados": r.Minutos_Tardanza_Acumulados,
    "Horas PDV": Math.round((r.Minutos_PDV / 60) * 10) / 10,
    "Horas Traslado": Math.round((r.Minutos_Traslado / 60) * 10) / 10,
    "Exceso Descanso Total (min)": r.Exceso_Descanso_Total_Min,
    "Dias Sin Entrada": r.Dias_Sin_Entrada,
  }));

  // ---- Hoja 2: Detalle Diario ----
  const detalleDiario = resumenes.map((r) => ({
    "ID Empleado": r.id_empleado,
    "Nombre": r.nombre,
    "Fecha": r.fecha,
    "Check-in": r.primer_checkin,
    "Check-out": r.ultimo_checkout,
    "Estado": r.clasificacion_puntualidad,
    "Tardanza (min)": r.minutos_tardanza,
    "Descanso (min)": r.minutos_descanso_total,
    "Exceso Descanso (min)": r.minutos_exceso_descanso,
    "Minutos PDV": r.minutos_pdv,
    "Minutos Traslado": r.minutos_traslado,
    "PDVs Únicos": r.pdvs_unicos_visitados,
    "PDVs Visitados": r.lista_pdvs,
    "Marcación Abierta": r.tiene_marcacion_abierta ? "Sí" : "No",
  }));

  // ---- Hoja 3: Inconsistencias ----
  const inconsistencias = detalleDiario.filter(
    (r) =>
      r["Marcación Abierta"] === "Sí" ||
      r["Estado"] === "Tardanza Grave" ||
      r["Exceso Descanso (min)"] > 0
  );

  // ---- Hoja 4 (extra, trazabilidad): marcaciones fila a fila ----
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
  const hojaResumen = XLSX.utils.json_to_sheet(
    resumenEjecutivo.length ? resumenEjecutivo : [{ Info: "Sin datos para el periodo" }]
  );
  const hojaDetalle = XLSX.utils.json_to_sheet(
    detalleDiario.length ? detalleDiario : [{ Info: "Sin datos" }]
  );
  const hojaInconsistencias = XLSX.utils.json_to_sheet(
    inconsistencias.length ? inconsistencias : [{ Info: "Sin inconsistencias" }]
  );
  const hojaMarcaciones = XLSX.utils.json_to_sheet(
    detalleMarcaciones.length ? detalleMarcaciones : [{ Info: "Sin datos" }]
  );

  XLSX.utils.book_append_sheet(wb, hojaResumen, "Resumen Ejecutivo");
  XLSX.utils.book_append_sheet(wb, hojaDetalle, "Detalle Diario");
  XLSX.utils.book_append_sheet(wb, hojaInconsistencias, "Inconsistencias");
  XLSX.utils.book_append_sheet(wb, hojaMarcaciones, "Marcaciones Detalle");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/octet-stream" });
  descargarBlob(blob, `Consolidado_Asistencia_${periodo}.xlsx`);
}

/**
 * @param {Array} registrosDelDia - filas de asistencia_resumen_diario (con `nombre`) de una sola fecha
 * @param {string} fecha - "YYYY-MM-DD"
 */
function exportarPdfResumenDiario(registrosDelDia, fecha) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "cm", format: "letter" });
  const azul = [46, 80, 144];

  doc.setFontSize(16);
  doc.setTextColor(...azul);
  doc.text("Ficha Ejecutiva Diaria — Control de Asistencia y Rutas", 1.2, 1.3);
  doc.setFontSize(10);
  doc.setTextColor(120, 120, 120);
  const [y, m, d] = fecha.split("-");
  doc.text(`Fecha: ${d}/${m}/${y}`, 1.2, 1.9);

  if (!registrosDelDia.length) {
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(11);
    doc.text("No hay registros de asistencia para esta fecha.", 1.2, 2.8);
  } else {
    const total = registrosDelDia.length;
    const puntuales = registrosDelDia.filter((r) => r.clasificacion_puntualidad === "Puntual").length;
    const tardanzas = registrosDelDia.filter((r) =>
      ["Tardanza Leve", "Tardanza Grave"].includes(r.clasificacion_puntualidad)
    ).length;
    const sinEntrada = registrosDelDia.filter((r) => r.clasificacion_puntualidad === "Sin Entrada").length;
    const excesos = registrosDelDia.filter((r) => r.alerta_exceso_descanso).length;

    doc.autoTable({
      startY: 2.3,
      head: [["Colaboradores", "Puntuales", "Con Tardanza", "Sin Entrada", "Exceso Descanso"]],
      body: [[total, puntuales, tardanzas, sinEntrada, excesos]],
      theme: "grid",
      headStyles: { fillColor: azul, halign: "center" },
      bodyStyles: { halign: "center", fontSize: 9 },
      margin: { left: 1.2, right: 1.2 },
    });

    const filas = registrosDelDia
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((r) => {
        let ruta = r.lista_pdvs || "-";
        if (ruta.length > 40) ruta = ruta.slice(0, 37) + "...";
        return [
          r.nombre,
          r.primer_checkin || "-",
          r.ultimo_checkout || (r.tiene_marcacion_abierta ? "Abierta" : "-"),
          r.clasificacion_puntualidad,
          r.minutos_tardanza,
          r.minutos_descanso_total,
          r.pdvs_unicos_visitados,
          ruta,
        ];
      });

    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 0.6,
      head: [["Colaborador", "Check-in", "Check-out", "Estado", "Tardanza (min)", "Descanso (min)", "PDVs", "Ruta"]],
      body: filas,
      theme: "grid",
      headStyles: { fillColor: azul, fontSize: 8 },
      bodyStyles: { fontSize: 7.5 },
      margin: { left: 1.2, right: 1.2 },
      didParseCell: function (data) {
        if (data.section !== "body") return;
        const row = registrosDelDia.sort((a, b) => a.nombre.localeCompare(b.nombre))[data.row.index];
        if (!row) return;
        if (row.clasificacion_puntualidad === "Tardanza Grave" || row.tiene_marcacion_abierta) {
          data.cell.styles.fillColor = [250, 219, 216];
        } else if (row.clasificacion_puntualidad === "Tardanza Leve" || row.alerta_exceso_descanso) {
          data.cell.styles.fillColor = [253, 235, 208];
        } else if (row.clasificacion_puntualidad === "Puntual") {
          data.cell.styles.fillColor = [213, 245, 227];
        }
      },
    });
  }

  const hoy = new Date().toLocaleDateString("es-ES");
  doc.setFontSize(8);
  doc.setTextColor(140, 140, 140);
  doc.text(
    `Generado automáticamente el ${hoy} — Sistema de Control de Asistencia y Gestión de Rutas PDV`,
    1.2,
    doc.internal.pageSize.getHeight() - 1
  );

  doc.save(`Ficha_Diaria_${fecha}.pdf`);
}
