# GU TRADE — Control de Asistencia y Gestión de Rutas PDV

Dashboard **100% local**: HTML + JavaScript puro, sin backend, sin base de
datos externa. Todo el procesamiento (lectura de Excel, cálculo de reglas de
negocio, generación de reportes) y todo el almacenamiento (histórico mes a
mes) ocurren dentro del propio navegador (IndexedDB).

## Archivos para subir a GitHub Pages

Sube estos 7 archivos a la raíz del repo (o usa `index_standalone.html` como
`index.html` si prefieres un solo archivo):

```
index.html              -> Estructura de la interfaz (referencia CSS/JS externos)
styles.css               -> Sistema visual
db.js                    -> Persistencia local con IndexedDB
etl.js                   -> Lectura/limpieza del Excel en bruto (SheetJS)
businessLogic.js          -> REGLA CENTRAL de asistencia + formateo de minutos
reportsClient.js          -> Exportación a Excel consolidado y PDF diario
app.js                   -> Orquestador: ingesta, filtros, KPIs, gráficos
index_standalone.html     -> Alternativa: TODO (CSS+JS) en un solo archivo
```

Si usas `index_standalone.html`, renómbralo a `index.html` en tu repo (no
subas los dos a la vez con el mismo contenido de `<title>`, para evitar
confusión sobre cuál edita).

## Reglas de asistencia (única fuente de verdad: `businessLogic.js`)

- **Hora oficial de entrada:** 08:00 (configurable en el panel "02 — Reglas de negocio").
- **Tolerancia:** 10 minutos.
- **Entrada hasta las 08:10 inclusive → "Puntual".**
- **Entrada de 08:11 a 08:29 inclusive → "Tardanza Leve".**
- **Entrada desde las 08:30 en adelante → "Tardanza a Supervisar".**
- **Sin marcación de entrada válida → "Sin Entrada".**
- Los minutos mostrados ("Min. desde las 08:00") **nunca** descuentan la
  tolerancia: una entrada a las 08:26 siempre muestra "26 min", aunque su
  estado sea "Tardanza Leve".
- **Cantidad de tardanzas** cuenta únicamente entradas desde las 08:11
  (eventos, no minutos). Las entradas puntuales (hasta 08:10) nunca se cuentan
  como tardanza aunque muestren minutos (1-10) en la columna de tiempo.

Toda tarjeta, la tabla, los gráficos, los filtros, el Excel y el PDF llaman a
la **misma función** `clasificarPuntualidad()` — no hay una segunda copia de
la regla en ningún otro archivo.

## Unidades de tiempo

Toda duración se formatea con `formatMinutos()` (definida en
`businessLogic.js`), que:
- Nunca muestra un número sin la palabra "min".
- Para duraciones ≥60 min, agrega la equivalencia legible: `"75 min (1 h 15 min)"`.
- Devuelve `"—"` en vez de `NaN`/`undefined`/`null` si el dato no es válido.

El descanso usa además `formatDescanso()`, que muestra el exceso sobre el
límite configurado de forma inequívoca: `"61 min (+1 min)"` en vez de `"61 +1"`.

## Nuevo: Rutas asignadas (cumplimiento por PDV y día de la semana)

En el panel lateral **"01b — Rutas asignadas"** podés subir un Excel aparte
(catálogo, no cambia mes a mes) con qué PDV le corresponde a cada colaborador
y en qué días de la semana. Formato esperado (según la hoja real que
compartiste), primera hoja del archivo:

| Cliente | Persona de Interes | Punto de venta | VISITA | IDENTIFICADOR |
|---|---|---|---|---|
| Cliente A | Juan Pérez | Farmacia Norte | LU,MI,VI | PDV0001 |

- `VISITA` trae códigos de día separados por coma: `LU, MA, MI, JU, VI, SA`.
- **Si `VISITA` viene vacía, esa fila no genera ninguna obligación** — se
  ignora por completo para el cálculo de cumplimiento (solo se mide lo que
  la persona efectivamente visitó, tal como pediste).
- Si una persona **no aparece en absoluto** en este catálogo, tampoco se le
  exige nada — sigue funcionando exactamente igual que antes.
- El cruce entre este catálogo y el Excel de marcaciones se hace **por
  nombre de colaborador** (no hay ID en la hoja de rutas) y **por nombre de
  PDV** (no por el identificador — el identificador se guarda pero no se usa
  para el cruce, ya que el Excel de marcaciones no lo trae).

La tabla de auditoría muestra una columna **"Cobertura de ruta"**:
`3/3` en verde si visitó todos los PDV que le tocaban ese día de la semana,
`2/3` en rojo (con el detalle de qué faltó en el tooltip) si no, o `—` si esa
persona no tiene ruta asignada para ese día. Las rutas incompletas también
aparecen como una categoría nueva en la franja "Atención requerida".

**Al subir un archivo de rutas nuevo, se recalcula automáticamente todo el
histórico ya cargado** con el catálogo actualizado.

## Corrección importante: formato real del Excel de marcaciones

Al revisar el Excel real que exporta el sistema, se detectó que **no usa una
columna "Punto de Venta"** como se había asumido — usa:
- **"Identificador de Punto de Interés"**: código del PDV (ej. `PDV0347`),
  vacío en filas de Descanso/Traslado.
- **"Actividad"**: combina código y nombre, ej. `"PDV0347 - JOBS OFICINA"`.

`etl.js` ahora reconoce este formato: separa el identificador y el nombre
automáticamente (quitándole el identificador como prefijo al texto de
Actividad — no asume que siempre empiece con "PDV", porque no es así en
todos los casos). Esto corrige de raíz el problema de "PDV visitados por
día: 0.0" — probado contra un archivo real: 1341 filas, **176 puntos de
venta únicos detectados correctamente** (antes: 0).

También se detecta ahora **"Identificador de Persona de Interés"** como ID
de empleado (antes dependía de una coincidencia de texto genérica menos
confiable).

## Cruce de rutas por identificador (no por nombre)

Como ambos archivos (marcaciones y rutas asignadas) comparten el mismo
sistema de códigos de PDV, el cumplimiento de ruta ahora cruza **primero por
identificador** (ej. `pdv0347`) y solo cae al nombre del PDV como respaldo si
el catálogo de rutas no trae identificador para esa fila. Mucho más
confiable que comparar texto libre.

## Sincronización en vivo con Google Sheets

En el panel **"01b — Rutas asignadas"** ahora hay dos formas de cargar el
catálogo de rutas:

1. **Sincronización en vivo** (nueva): pegás el enlace de exportación CSV de
   tu hoja publicada de Google Sheets y presionás "Sincronizar ahora". El
   tablero descarga el CSV directo desde el navegador (sin backend propio) y
   actualiza el catálogo. Hay un checkbox para que esto pase automáticamente
   cada vez que procesás un Excel de marcaciones nuevo.
2. **Archivo manual** (como antes): subís un `.xlsx` exportado de la hoja.

**Cómo publicar la hoja en Google Sheets** (para que el enlace funcione):
`Archivo → Compartir → Publicar en la web → elegir la hoja específica →
formato CSV → Publicar → copiar el enlace`. Tiene que estar **publicada**,
no solo "compartida" — son configuraciones distintas en Google Sheets.

⚠️ **Esto no se pudo probar contra el Google Sheets real** (este entorno de
desarrollo no tiene salida a internet hacia los dominios de Google). Se
probó exhaustivamente con una respuesta CSV simulada (parseo, actualización
del catálogo, recálculo automático, manejo de errores de red), pero conviene
que confirmes en tu navegador que el enlace publicado responde correctamente
la primera vez que lo uses.

## Qué cambió en esta revisión

- **Se quitaron 3 gráficos**: "Evolución diaria de asistencia", "Distribución
  del tiempo de trabajo" y "Tendencia mensual histórica". Solo quedan
  "Colaboradores con más tardanzas" (arriba) y "Minutos de tardanza por
  colaborador" (en la sección desplegable "Análisis detallado de tardanzas").
- **Tooltip explicando "Abierta"**: tanto en cada etiqueta de estado como en
  el encabezado de la columna "Estado", aclarando que significa que no se
  registró la salida de un punto de venta ese día.
- **Filtro de fechas agrupado**: "Desde" y "Hasta" ahora se presentan bajo un
  único rótulo "Rango de fechas" para que se lean como un solo filtro de
  calendario.
- **Desplegable de "Ruta del día"**: al tocar el nombre de un colaborador en
  la tabla, se despliega una fila con el detalle completo:
  - Si tiene ruta asignada ese día de la semana: lista cada punto de venta
    que **debía** visitar, con un check ✓ (visitó, con su hora real de
    entrada y salida) o una cruz ✗ (no lo visitó).
  - Si no tiene ruta asignada: lista los puntos de venta que efectivamente
    visitó, con sus horarios, sin evaluar cumplimiento (tal como se definió
    anteriormente).
  La columna "Ruta del día" en la tabla ahora muestra solo un resumen
  compacto (abreviaturas + cantidad); el detalle completo con horarios vive
  en el desplegable.

- **Tipografía → Arial** en todo el tablero (interfaz y gráficos), quitando
  la dependencia de Google Fonts (el tablero ahora funciona 100% offline).
- **Tarjetas KPI**: se quitaron "Minutos de tardanza" y "PDV por día"; en su
  lugar se agregaron **"Horas efectivas"** (promedio de horas trabajadas por
  día, descontando el descanso) y **"Jornada incompleta"** (días por debajo
  de la jornada obligatoria configurada).
- **Nueva regla configurable: Horas de jornada obligatorias** (por defecto 8
  h, panel "02 — Reglas de negocio"). Para cada día se calcula:
  - `minutos_trabajados` (bruto: última salida − primera entrada).
  - `minutos_efectivos` (`minutos_trabajados − descanso`).
  - `cumplio_jornada` (`minutos_efectivos >= horas_jornada_esperada`).
  Se decidió comparar contra las **horas efectivas** (no contra un horario de
  salida fijo), porque alguien que entra tarde pero se queda hasta completar
  su jornada sí cumplió, aunque su hora de salida sea "tarde" según el reloj.
- Tabla: dos columnas nuevas al final ("Horas efectivas" y "Jornada") para no
  romper los índices de columnas existentes.
- **Ruta visual**: el tooltip de cada parada ahora muestra los minutos reales
  que el colaborador estuvo en ese PDV (antes solo mostraba el nombre).
- Excel y PDF actualizados con las mismas columnas nuevas.

## Pendiente: "ruteo" (rutas planificadas vs. rutas efectivamente recorridas)

Quedó pendiente de implementar el sistema de rutas asignadas por
colaborador/cliente (para poder comparar "lo que debía visitar" contra "lo
que efectivamente visitó"). El diseño propuesto, a confirmar antes de
construirlo:
- Una hoja adicional dentro del mismo Excel (o un archivo separado) con las
  rutas asignadas por colaborador.
- Los colaboradores CON ruta asignada se evalúan por cobertura (visitó
  todos los puntos asignados o no, y cuáles faltaron).
- Los colaboradores SIN ruta asignada siguen mostrando lo que efectivamente
  visitaron, sin evaluación de cobertura (como ya funciona hoy).

**Rediseño visual completo** ("tablero ejecutivo") manteniendo intactas todas
las reglas de negocio, cálculos y funciones previas:

- Sidebar reorganizada: secciones numeradas con íconos, botón "Procesar
  Excel" destacado, y **Historial de procesos** con datos reales de
  IndexedDB (punto verde = proceso completado, amarillo = con advertencias
  reales — file-quality o inconsistencias de negocio detectadas).
- Header ejecutivo: chip con período + cantidad de registros, botones
  Excel/PDF reubicados ahí.
- Nueva franja **"Atención requerida"**: total de registros únicos con
  inconsistencia (sin duplicar conteo) + contadores por categoría (sin
  entrada, marcación abierta, descansos excedidos, entrada posterior a la
  salida, tiempo >24h, otras). Los chips filtran la tabla al hacer clic.
- Tarjetas KPI con íconos SVG propios (sin librerías externas) y unidad
  explícita ("eventos" en Cantidad de tardanzas).
- Gráfico "Minutos de tardanza por colaborador" movido a una sección
  desplegable "Análisis detallado de tardanzas" (con recálculo de tamaño de
  Chart.js al abrirla, porque un `<canvas>` dentro de `display:none` no
  calcula bien sus dimensiones).
- Toolbar de la tabla ampliado: filtro de PDV, búsqueda de colaborador por
  texto, y **paginación** (filas por página configurable, controles «/1 2 3/»).
- Ruta visual mejorada: abreviaturas + flechas (`SUP → MAX → FAR`), con
  nombre completo en tooltip; "Sin registro de ruta" cuando no hay datos.
- Sidebar colapsable en pantallas pequeñas (botón ☰ flotante).
- Accesibilidad: `aria-label`, `:focus-visible`, `prefers-reduced-motion`,
  navegación por teclado nativa (todo son elementos HTML estándar).

**Bugs reales corregidos en el camino** (no solo estética):
1. El historial de procesos no se actualizaba tras subir un Excel (llamaba
   a la función equivocada de refresco).
2. El punto de estado del historial solo consideraba problemas de calidad
   del archivo, no inconsistencias de negocio (como descansos excedidos) —
   ahora ambos casos marcan el punto en amarillo, consistente con lo que
   muestra "Atención requerida".
3. Clic en un chip de categoría podía fallar en navegadores sin
   `scrollIntoView` — se blindó con verificación defensiva.

## Simplificaciones y supuestos (documentados, no ocultos)

- **"Ruta" y "PDV" se unificaron en un solo filtro** en la barra de la
  tabla — son la misma dimensión de dato (ambos apuntan a puntos de venta
  visitados), así que un filtro separado de "Ruta" habría sido redundante
  con el de "PDV".
- El campo `tiene_advertencias` del historial de procesos es **retroactivo
  solo desde esta revisión en adelante** — los períodos cargados antes de
  este cambio no tendrán ese dato hasta que se vuelvan a procesar o se
  recalculen.
- No existía en el código original una regla explícita de "tiempo total
  imposible" por día; se mantiene el umbral de >24h ya usado en la revisión
  anterior para esa categoría de "Atención requerida".
- La paginación es puramente de presentación (no afecta qué filas exporta
  Excel, que sigue usando el dataset completo filtrado).

0. **Comportamiento al abrir la pestaña.** Ahora el dashboard **nunca se
   muestra automáticamente** al abrir la página, aunque ya existan datos
   guardados de una carga anterior en ese navegador. Solo aparece cuando:
   - se procesa un Excel con éxito, o
   - se cambia el período (radio "Mes actual/específico/comparativa" o el
     selector de mes), o
   - se pulsa el botón **"Ver historial guardado"** que aparece en la
     pantalla vacía cuando ya hay datos previos.
   Los datos siguen intactos en IndexedDB en todo momento — esto solo cambia
   si se muestran automáticamente o no al entrar.
1. **Bug corregido en la función central de clasificación.** Antes, el
   sistema le restaba la tolerancia al cálculo antes de comparar contra el
   límite de "leve", lo que hacía que una entrada a las 08:29 se clasificara
   incorrectamente como grave. Ahora la comparación es directa contra minutos
   absolutos desde la hora oficial (10 / 29 / 30+), validado contra los 9
   casos exactos de prueba.
2. **"Tardanza Grave" renombrado a "Tardanza a Supervisar"** en tabla,
   tarjetas, gráficos, leyendas, filtros, tooltips, Excel y PDF.
3. **"Minutos acumulados de tardanza"** ahora solo suma minutos de filas
   realmente clasificadas como tardanza (antes también sumaba los minutos de
   las entradas puntuales, inflando el total).
4. **Formateo de minutos centralizado y consistente** en toda la app —
   ninguna cifra de tiempo aparece sin su unidad.
5. **Filtros de Colaborador/Estado**: se reemplazó el `<select multiple>`
   nativo (que en algunos navegadores muestra "0 elementos seleccionados") por
   un componente propio que muestra "Todos los colaboradores" / "Todos los
   estados" / el nombre elegido / "N seleccionados".
6. **Botón "Limpiar filtros"** y etiqueta **"Período analizado"** agregados.
7. **Nuevo gráfico separado** "Minutos de tardanza por colaborador" (antes
   solo existía el ranking por cantidad de eventos; ahora cantidad y duración
   nunca se mezclan en el mismo gráfico).
8. **Detección de inconsistencias** (registros duplicados, fechas/horas
   inválidas, descanso negativo, marcaciones sin entrada/salida, exceso de
   descanso) que se muestran en el resumen de carga, se marcan en la tabla
   (⚠, sin eliminar el registro) y se listan en Excel/PDF.
9. **Resumen de carga del Excel**: nombre de archivo, filas procesadas,
   colaboradores detectados, fecha inicial/final, registros válidos e
   inconsistencias detectadas, con indicador de carga (spinner).
10. **Excel consolidado**: hoja "Información" con período analizado, filtros
    aplicados y fecha/hora de generación; encabezados con unidades explícitas
    ("Minutos desde las 08:00", "Descanso (min)"); respeta los filtros
    activos en pantalla (colaborador/estado/fechas) para Resumen Ejecutivo,
    Detalle Diario e Inconsistencias — la hoja "Marcaciones Detalle" siempre
    incluye el período completo sin filtrar, como respaldo de auditoría.
11. **PDF diario**: estados renombrados, sección de inconsistencias agregada,
    unidades visibles en todas las columnas de tiempo.
12. **Tabla de auditoría**: encabezado y primera columna (colaborador) fijos
    al desplazar, tooltips explicativos en "Min. desde las 08:00" y "Descanso
    (min)", nunca muestra "NaN"/"undefined"/"null" (usa "—").

## Confirmaciones solicitadas

- ✅ La tolerancia llega hasta las 08:10 inclusive (verificado: 08:10 → 10 min → Puntual).
- ✅ La tardanza leve comienza a las 08:11 (verificado: 08:11 → 11 min → Tardanza Leve).
- ✅ "Tardanza a Supervisar" comienza a las 08:30 (verificado: 08:30 → 30 min → Tardanza a Supervisar).
- ✅ La cantidad de tardanzas cuenta eventos, no minutos (verificado: 5 tardanzas para 5 entradas tardías, independientemente de sus minutos).
- ✅ Todos los gráficos de duración trabajan en minutos; los de cantidad usan enteros y nunca se mezclan.
- ✅ Excel y PDF usan la misma función central de clasificación y el mismo formateador de minutos que el resto del dashboard.
- **Límite de descanso permitido:** ya existía en el código antes de esta revisión (parámetro configurable, 60 min por defecto, panel "02 — Reglas de negocio"). No se inventó un valor nuevo; solo se hizo visible con claridad ("61 min (+1 min)").
- **Dato no determinable en el código original:** no había una regla explícita de "tiempo total imposible" por día; se agregó un umbral razonable (>24 h) como detección de inconsistencia, ya que no había un límite previo definido para ese caso específico.

## Nota sobre el diagnóstico de "PDV visitados por día: 0.0"

Si esa tarjeta muestra 0.0 con datos reales cargados, casi seguro es porque
tu Excel usa un nombre de columna para "Punto de Venta" distinto a los
reconocidos por `COLUMN_ALIASES` en `etl.js`. Desde esta revisión, el resumen
de carga (después de subir el Excel) avisa explícitamente qué columnas
opcionales no pudo detectar, por ejemplo:
`"No se detectó la columna 'Punto de Venta' — esos datos quedarán vacíos o en 0"`.
Si ves ese aviso, dime el nombre exacto del encabezado en tu Excel real y lo
agrego a la lista de alias reconocidos.

## Pruebas automatizadas

`test/integration_test_local.js` carga la app real (multi-archivo) dentro de
un navegador simulado (jsdom + `fake-indexeddb`), sube un Excel con los 9
horarios exactos de la tabla de pruebas obligatoria, y verifica: estado y
minutos de cada caso, formato de descanso con exceso, KPIs, filtro por
estado, botón "Limpiar filtros", exportación a Excel sin errores, y **cero
errores de consola** durante toda la ejecución.

`test/integration_test_standalone.js` corre exactamente las mismas pruebas
contra `index_standalone.html` (el archivo combinado en uno solo), para
confirmar que ambas versiones se comportan idénticamente.

```bash
npm install
npm test
```

## Notas generales (de la versión anterior, siguen vigentes)

- Los datos se guardan solo en el navegador donde se usa la app (IndexedDB),
  no se comparten entre computadoras ni personas.
- `etl.js` reconoce variantes comunes de encabezado del Excel (ID/Nombre de
  Persona de interés, Punto de Venta, Actividad, Fecha, Hora inicio/salida,
  Tiempo transcurrido). Si tu Excel real usa encabezados distintos, amplía
  `COLUMN_ALIASES` al inicio de `etl.js`.
- El botón "Borrar todos los datos locales" limpia por completo el IndexedDB
  de este navegador.
