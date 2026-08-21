// ============================================================================
// db.js — Persistencia 100% local con IndexedDB (sin backend, sin Supabase).
//
// IMPORTANTE: los datos se guardan SOLO en el navegador donde se usa la app
// (IndexedDB del dispositivo). No se comparten entre computadoras ni
// usuarios. Si varias personas usan el dashboard, cada una ve solo lo que
// ella misma subió en su propio navegador. Para compartir el histórico entre
// varias personas se necesitaría una base de datos remota (fuera del alcance
// de esta versión, que es intencionalmente 100% offline/local).
// ============================================================================

const DB_NAME = "asistencia_pdv_db";
const DB_VERSION = 1;
let dbPromise = null;

function abrirDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (evento) => {
      const db = evento.target.result;

      if (!db.objectStoreNames.contains("empleados")) {
        db.createObjectStore("empleados", { keyPath: "id_empleado" });
      }
      if (!db.objectStoreNames.contains("marcaciones_detalle")) {
        const os = db.createObjectStore("marcaciones_detalle", { keyPath: "id", autoIncrement: true });
        os.createIndex("periodo", "periodo", { unique: false });
        os.createIndex("id_empleado", "id_empleado", { unique: false });
      }
      if (!db.objectStoreNames.contains("asistencia_resumen_diario")) {
        const os = db.createObjectStore("asistencia_resumen_diario", { keyPath: "id", autoIncrement: true });
        os.createIndex("periodo", "periodo", { unique: false });
        os.createIndex("id_empleado", "id_empleado", { unique: false });
      }
      if (!db.objectStoreNames.contains("periodos_cargados")) {
        db.createObjectStore("periodos_cargados", { keyPath: "periodo" });
      }
      if (!db.objectStoreNames.contains("configuracion")) {
        db.createObjectStore("configuracion", { keyPath: "clave" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function conTransaccion(storeNames, modo, callback) {
  return abrirDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, modo);
        const resultado = callback(tx);
        tx.oncomplete = () => resolve(resultado);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

function dbGetAll(storeName) {
  return abrirDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function dbGetByIndex(storeName, indexName, valorOValores) {
  const valores = Array.isArray(valorOValores) ? valorOValores : [valorOValores];
  return abrirDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const idx = tx.objectStore(storeName).index(indexName);
        const resultados = [];
        let pendientes = valores.length;
        if (!pendientes) return resolve([]);
        valores.forEach((valor) => {
          const req = idx.getAll(valor);
          req.onsuccess = () => {
            resultados.push(...req.result);
            pendientes -= 1;
            if (pendientes === 0) resolve(resultados);
          };
          req.onerror = () => reject(req.error);
        });
      })
  );
}

function dbPutMany(storeName, registros) {
  return conTransaccion(storeName, "readwrite", (tx) => {
    const store = tx.objectStore(storeName);
    registros.forEach((r) => store.put(r));
  });
}

function dbPut(storeName, registro) {
  return dbPutMany(storeName, [registro]);
}

function dbDeleteByIndex(storeName, indexName, valor) {
  return conTransaccion(storeName, "readwrite", (tx) => {
    const store = tx.objectStore(storeName);
    const idx = store.index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(valor));
    req.onsuccess = (evento) => {
      const cursor = evento.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

function dbClearAll() {
  const stores = ["empleados", "marcaciones_detalle", "asistencia_resumen_diario", "periodos_cargados", "configuracion"];
  return conTransaccion(stores, "readwrite", (tx) => {
    stores.forEach((s) => tx.objectStore(s).clear());
  });
}

// ---------------------------------------------------------------------------
// Configuración por defecto (se siembra la primera vez que se abre la app)
// ---------------------------------------------------------------------------
const CONFIG_DEFAULT = [
  { clave: "hora_entrada_teorica", valor: "08:00" },
  { clave: "tolerancia_min", valor: "10" },
  { clave: "tardanza_leve_max_min", valor: "15" },
  { clave: "descanso_permitido_min", valor: "60" },
];

async function asegurarConfiguracionInicial() {
  const existentes = await dbGetAll("configuracion");
  if (!existentes.length) {
    await dbPutMany("configuracion", CONFIG_DEFAULT);
  }
}
