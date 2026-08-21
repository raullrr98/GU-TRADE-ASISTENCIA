# GU TRADE — Control de Asistencia y Gestión de Rutas PDV

Dashboard **100% local**: HTML + JavaScript puro, sin backend, sin base de
datos externa, sin Supabase. Todo el procesamiento (lectura de Excel, cálculo
de reglas de negocio, generación de reportes) y todo el almacenamiento
(histórico mes a mes) ocurren dentro del propio navegador.

## Importante: alcance de los datos

Los datos se guardan en **IndexedDB del navegador** donde se usa la app.
Esto significa:

- Persisten entre sesiones (cierras el navegador, lo vuelves a abrir, y el
  histórico sigue ahí) — probado explícitamente en las pruebas automatizadas.
- **No se comparten** entre computadoras ni entre personas. Si dos personas
  distintas abren la misma URL desde sus propios navegadores, cada una ve
  solo lo que ella misma cargó.
- Si necesitas que varias personas vean el mismo histórico compartido, hace
  falta una base de datos remota (eso quedó fuera del alcance de esta
  versión a propósito, para mantenerla simple y sin dependencias externas).

## Cómo usarlo

1. Sube `index.html`, `styles.css`, `db.js`, `etl.js`, `businessLogic.js`,
   `reportsClient.js` y `app.js` a tu repositorio de GitHub (todos en la raíz,
   o todos dentro de la misma carpeta).
2. Activa GitHub Pages (Settings → Pages → Deploy from branch).
3. Abre la URL — no hay ninguna pantalla de configuración ni claves que
   pegar. Funciona de inmediato.
4. Sube tu primer Excel mensual desde el panel **01 — Cargar manifiesto**.

## Estructura

```
index.html            -> Estructura de la interfaz
styles.css             -> Sistema visual (identidad "manifiesto de despacho")
db.js                  -> Persistencia local con IndexedDB
etl.js                 -> Lectura/limpieza del Excel en bruto (SheetJS)
businessLogic.js        -> Reglas de negocio (puntualidad, descansos, PDV/traslado)
reportsClient.js        -> Exportación a Excel consolidado y PDF diario
app.js                  -> Orquestador: ingesta, filtros, KPIs, gráficos (Chart.js)
test/                  -> Pruebas automatizadas (Node + IndexedDB simulado)
```

## Identidad visual

El dashboard sigue un sistema de diseño propio ("manifiesto de despacho"),
pensado para una herramienta operativa que se escanea rápido, no para lucirse:

- **Color:** grafito casi negro en el riel lateral, papel cálido-grisáceo de
  fondo, ámbar de seguridad como acento de marca; verde/ámbar-mostaza/rojo
  para los tres niveles de alerta.
- **Tipografía:** *Barlow Condensed* (mayúsculas) para etiquetas y
  encabezados, *Inter* para texto de interfaz, *IBM Plex Mono* para todos los
  números, horas y minutos (para que los datos tabulares alineen como una
  bitácora).
- **Firma visual:** la columna "Ruta del día" no muestra el texto plano de
  los PDVs visitados — dibuja una secuencia de puntos conectados por una
  línea, en el orden real en que el colaborador los visitó, como un mini mapa
  de línea de transporte.

## Análisis incluidos

- KPIs del período: colaboradores, % puntualidad, tardanzas, minutos
  perdidos, promedio de PDVs visitados por día.
- Ranking de top reincidentes en tardanzas.
- Evolución diaria de puntualidad vs. tardanzas.
- Distribución del tiempo de trabajo (PDV / Traslado / Descanso).
- Tendencia mensual histórica (% puntualidad y tardanzas por mes, requiere 2+
  meses cargados).
- Bitácora diaria de auditoría con estado (puntual / tardanza leve / tardanza
  grave / sin entrada / marcación abierta) y exceso de descanso resaltado.
- Exportación a Excel consolidado (Resumen Ejecutivo, Detalle Diario,
  Inconsistencias, Marcaciones) y a PDF de ficha ejecutiva diaria.

## Selector de período y comparativa entre meses

- **Mes actual**: el período más reciente cargado.
- **Mes específico**: cualquier mes ya cargado, elegido de una lista.
- **Comparativa**: selecciona varios meses para ver sus datos combinados en
  los KPIs, gráficos y la bitácora (la tendencia histórica siempre usa todos
  los meses cargados, sin importar el modo de vista activo).

## Recalcular el histórico al cambiar reglas de negocio

El panel **02 — Reglas de negocio** permite ajustar la hora de entrada
teórica, la tolerancia, el límite de tardanza leve y el descanso permitido.
Al guardar, **todo el histórico cargado se recalcula** con las nuevas reglas
(no solo el mes actual).

## Borrar los datos locales

El botón "Borrar todos los datos locales" del panel lateral limpia por
completo el IndexedDB de este navegador (útil para volver a empezar o para
pruebas). Pide confirmación antes de borrar.

## Pruebas incluidas

`test/integration_test_local.js` carga la app real dentro de un navegador
simulado (jsdom) con IndexedDB simulado (`fake-indexeddb`), sube un Excel de
prueba, calcula las reglas de negocio, aplica filtros, y **simula un reload
completo de la página** para confirmar que los datos realmente persisten
entre sesiones. Para correrla:

```bash
npm install
npm test
```

## Mapeo de columnas del Excel

`etl.js` reconoce variantes comunes de encabezado (ID de Persona de interés,
Nombre de Persona de interés, Punto de Venta, Actividad, Fecha, Hora inicio,
Hora de salida, Tiempo transcurrido), ignorando tildes/mayúsculas. Si tu Excel
real usa encabezados distintos, amplía el objeto `COLUMN_ALIASES` al inicio de
`etl.js`.
