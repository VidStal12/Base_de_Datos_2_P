const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const outbox = require('../src/services/ventasOutboxService');

// Los servicios se cargan con dependencias simuladas: estas pruebas no abren
// conexiones, no requieren datos del seed y no alteran ninguna base real.
function cargar(archivo, dependencias, env = {}) {
  const ruta = path.resolve(__dirname, archivo);
  const requireLocal = createRequire(ruta);
  const modulo = { exports: {} };
  vm.runInNewContext(fs.readFileSync(ruta, 'utf8'), {
    module: modulo,
    exports: modulo.exports,
    require: (nombre) => Object.hasOwn(dependencias, nombre) ? dependencias[nombre] : requireLocal(nombre),
    __dirname: path.dirname(ruta),
    process: { env },
    Date,
    console: { error() {}, log() {} },
    setInterval,
    clearInterval,
  }, { filename: ruta });
  return modulo.exports;
}

function evento() {
  return {
    detalle_id: 11,
    intentos: 0,
    procesado_en: null,
    proximo_intento: new Date('2026-01-01T00:00:00Z'),
    payload: {
      detalle_id: 11, compra_id: 7, producto_id: 3, vendedor_id: 2,
      fecha_venta: '2026-09-05T03:00:00.000Z', cantidad: 2,
      importe: '19.90', descuento: '4.10',
    },
  };
}

function crearWorker(fila, execute, adicionales = {}) {
  const actualizaciones = [];
  let lecturas = 0;
  const db = {
    venta_outbox: {
      async findMany({ where }) {
        lecturas += 1;
        return fila.procesado_en === null && fila.proximo_intento <= where.proximo_intento.lte ? [fila] : [];
      },
      async updateMany({ where, data }) {
        actualizaciones.push({ where, data });
        if (fila.procesado_en !== null) return { count: 0 };
        for (const [campo, valor] of Object.entries(data)) {
          if (campo === 'intentos') fila.intentos += valor.increment;
          else fila[campo] = valor;
        }
        return { count: 1 };
      },
    },
    ...adicionales,
  };
  const servicio = cargar('../src/services/ventasSyncService.js', {
    '../config/prisma': db,
    '../config/cassandra': { obtenerCliente: async () => ({ execute }) },
    './ventasOutboxService': outbox,
  });
  return { servicio, db, actualizaciones, lecturas: () => lecturas };
}

test('el outbox conserva importes netos exactos y el vendedor dentro de la transacción', async () => {
  const compra = {
    id: 7,
    fecha: new Date('2026-09-05T03:00:00Z'),
    compra_detalles: [{ id: 11, id_producto: 3, cantidad: 2, precio_final: '19.9', descuento: '4.1' }],
  };
  let filas;
  await outbox.encolarCompra({
    producto: { findMany: async () => [{ id: 3, id_vendedor: 2 }] },
    venta_outbox: { createMany: async ({ data }) => { filas = data; } },
  }, compra);
  assert.deepEqual(filas[0].payload, evento().payload);
  assert.equal(filas[0].payload.importe, '19.90');
  assert.equal('id_usuario' in filas[0].payload, false);
  assert.throws(() => outbox.crearPayload(compra, { ...compra.compra_detalles[0], precio_final: '1.234' }, 2), /decimal/);
});

test('un fallo entre proyecciones deja el pendiente y reintentar no duplica la venta', async () => {
  const fila = evento();
  const tablas = new Map();
  let fallaProducto = true;
  const { servicio, actualizaciones } = crearWorker(fila, async (consulta, valores, opciones) => {
    assert.equal(opciones.isIdempotent, true);
    const tabla = consulta.includes('ventas_por_producto_mes') ? 'producto' : 'dia';
    if (tabla === 'producto' && fallaProducto) throw new Error('Cassandra temporalmente no disponible');
    const clave = JSON.stringify([tabla, ...valores.slice(0, tabla === 'dia' ? 3 : 4)]);
    tablas.set(clave, valores);
  });
  const primero = await servicio.procesarPendientes();
  assert.equal(primero.fallidos, 1);
  assert.equal(fila.procesado_en, null);
  assert.equal(fila.intentos, 1);
  assert.ok(fila.proximo_intento > new Date());
  assert.equal(tablas.size, 1);

  fallaProducto = false;
  fila.proximo_intento = new Date('2026-01-01');
  const segundo = await servicio.procesarPendientes();
  assert.equal(segundo.procesados, 1);
  assert.equal(tablas.size, 2);
  assert.ok(fila.procesado_en instanceof Date);
  assert.equal(fila.ultimo_error, null);
  assert.equal(actualizaciones.every(({ where }) => where.procesado_en === null), true);

  const porDia = [...tablas.values()][0];
  assert.equal(porDia[0].toString(), '2026-09-04');
  assert.equal(porDia[7].toString(), '19.90');
  const porProducto = [...tablas.values()][1];
  assert.equal(porProducto[1].toString(), '2026-09-01');
  assert.equal((await servicio.procesarPendientes()).seleccionados, 0);
});

test('dos disparos simultáneos comparten el mismo lote y detener espera su confirmación', async () => {
  let liberar;
  const bloqueado = new Promise((resolve) => { liberar = resolve; });
  let escrituras = 0;
  const { servicio, lecturas } = crearWorker(evento(), async () => {
    escrituras += 1;
    await bloqueado;
  });
  const primera = servicio.procesarPendientes();
  const segunda = servicio.procesarPendientes();
  assert.equal(primera, segunda);
  let detenido = false;
  const parada = servicio.detener().then(() => { detenido = true; });
  await Promise.resolve();
  assert.equal(detenido, false);
  liberar();
  await parada;
  assert.equal(lecturas(), 1);
  assert.equal(escrituras, 2);
});

test('un snapshot inválido se conserva con error y no escribe Cassandra', async () => {
  const fila = evento();
  fila.payload.importe = 19.9;
  let escrituras = 0;
  const { servicio } = crearWorker(fila, async () => { escrituras += 1; });
  const resumen = await servicio.procesarPendientes();
  assert.equal(resumen.fallidos, 1);
  assert.equal(escrituras, 0);
  assert.equal(fila.procesado_en, null);
  assert.match(fila.ultimo_error, /importe/);
});

test('el backfill filtra pagos aprobados, pagina y reencola sin sustituir snapshots existentes', async () => {
  const consultas = [];
  const upserts = [];
  const detalle = {
    id: 11, id_producto: 3, cantidad: 2, precio_final: '19.90', descuento: '4.10',
    compra: { id: 7, fecha: new Date('2026-09-05T03:00:00Z') },
    producto: { id_vendedor: 2 },
  };
  const { servicio } = crearWorker(evento(), async () => {}, {
    compra_detalle: {
      async findMany(consulta) {
        consultas.push(consulta);
        return consultas.length === 1 ? [detalle] : [];
      },
    },
    $transaction: async (operar) => operar({ venta_outbox: { upsert: async (datos) => upserts.push(datos) } }),
  });
  assert.equal((await servicio.backfillHistorico()).encolados, 1);
  assert.equal(consultas[0].where.compra.pagos.some.estado, 'aprobado');
  assert.equal(consultas[1].where.id.gt, 11);
  assert.equal(upserts[0].update.procesado_en, null);
  assert.equal('payload' in upserts[0].update, false);
  assert.deepEqual(upserts[0].create.payload, evento().payload);
});

test('Cassandra reinicia conexión tras fallar y comparte un único cliente de consultas', async () => {
  const clientes = [];
  const consultas = [];
  class Client {
    constructor(opciones) { this.opciones = opciones; clientes.push(this); }
    async connect() { if (clientes.length === 1) throw new Error('aún arrancando'); }
    async execute(sentencia) { consultas.push(sentencia); }
    async shutdown() { this.cerrado = true; }
  }
  const config = cargar('../src/config/cassandra.js', { 'cassandra-driver': { Client } }, {
    CASSANDRA_KEYSPACE: 'ventas_prueba', CASSANDRA_LOCAL_DATACENTER: 'dc_prueba',
  });
  await assert.rejects(config.obtenerCliente(), /aún arrancando/);
  const [primero, segundo] = await Promise.all([config.obtenerCliente(), config.obtenerCliente()]);
  assert.equal(primero, segundo);
  assert.equal(clientes.length, 3);
  assert.equal(primero.opciones.keyspace, 'ventas_prueba');
  assert.equal(consultas.length, 3);
  assert.ok(consultas[0].includes("'dc_prueba': 1"));
  assert.ok(consultas.every((consulta) => consulta.includes('ventas_prueba')));
  await config.cerrar();
  assert.equal(clientes.every((cliente) => cliente.cerrado), true);
});

test('Cassandra rechaza identificadores antes de construir sentencias CQL', async () => {
  const config = cargar('../src/config/cassandra.js', {
    'cassandra-driver': { Client: class { constructor() { assert.fail('No debe conectarse'); } } },
  }, { CASSANDRA_KEYSPACE: 'ventas; DROP KEYSPACE otro' });
  await assert.rejects(config.obtenerCliente(), /CASSANDRA_KEYSPACE/);
});

// Probar la ubicación del outbox en ambos caminos del checkout es importante:
// una captura fuera de la transacción perdería ventas si Node termina al pagar.
for (const variante of ['checkout', 'checkoutOferta']) {
  test(`${variante}: con captura pausada confirma la compra sin consultar el outbox`, async () => {
    let confirmado = false;
    let cacheEscrita = false;
    const compra = {
      id: 7, fecha: new Date('2026-09-05T03:00:00Z'),
      compra_detalles: [{ id: 11, id_producto: 3, cantidad: 2, precio_final: '20.00', descuento: '4.50' }],
    };
    // No hay modelos producto/venta_outbox: cualquier consulta de captura falla.
    const tx = {
      direcciones: { findUnique: async () => ({ id_usuario: 7 }) },
      metodo_pago: { findUnique: async () => ({ id_usuario: 7 }) },
      inventario: { findUnique: async () => ({ cantidad: 10, precio: '12.25' }), updateMany: async () => ({ count: 1 }) },
      carrito: { deleteMany: async () => {} },
      compra: { create: async () => compra },
      pago: { create: async () => ({ id: 1, estado: 'aprobado' }) },
    };
    const capturaPausada = cargar('../src/services/ventasOutboxService.js', {}, { VENTAS_OUTBOX_ENABLED: 'false' });
    const servicio = cargar('../src/services/checkoutService.js', {
      '../config/prisma': {
        ...tx,
        usuarios: { findUnique: async () => ({ nombres: 'Prueba', apellidos: 'Flash', rol: { tipo_rol: 'comprador' } }) },
        $transaction: async (operar) => {
          const resultado = await operar(tx);
          confirmado = true;
          return resultado;
        },
      },
      '../config/mongo': { conectar: async () => {} },
      '../models/mongo/Producto': {
        updateOne: async () => { cacheEscrita = true; },
        find: () => ({ select: () => ({ lean: async () => [{ producto_id: 3, estado: 'activo' }] }) }),
        findOne: () => ({ select: () => ({ lean: async () => null }) }),
      },
      './cartService': { bloquearUsuario: async () => {}, invalidarCache: async () => {}, avanzarVersion: async () => {} },
      './checkoutIntentoService': { reutilizado: () => false },
      // checkoutService también valida "nadie compra lo suyo" y el compromiso de
      // no reventa; estas pruebas son de la captura del outbox, no de esas reglas.
      './productoService': { verificarNoEsPropio: async () => {}, verificarVendedoresActivos: async () => {} },
      './compromisoService': { exigirCompromiso: async () => ({ requerido: false, aceptadoEn: null }) },
      './fraudeSyncService': { registrarCompra: async () => {} },
      './ventasOutboxService': capturaPausada,
    });
    const resultado = await servicio[variante]({
      usuarioId: 7, direccionId: 1, metodoPagoId: 1, items: [{ productoId: 3, cantidad: 2 }],
      productoId: 3, cantidad: 2, precioUnitario: 10,
    });
    assert.equal(confirmado, true);
    assert.equal(resultado.compra, compra);
    assert.equal(resultado.pago.estado, 'aprobado');
    assert.equal(cacheEscrita, true);
  });

  test(`${variante}: un fallo de outbox revierte la transacción y no ejecuta las cachés`, async () => {
    let pagoCreado = false;
    let confirmado = false;
    let cacheEscrita = false;
    const tx = {
      direcciones: { findUnique: async () => ({ id_usuario: 7 }) },
      metodo_pago: { findUnique: async () => ({ id_usuario: 7 }) },
      inventario: { findUnique: async () => ({ cantidad: 10, precio: '12.25' }), updateMany: async () => ({ count: 1 }) },
      carrito: { deleteMany: async () => {} },
      compra: { create: async () => ({ id: 7, compra_detalles: [] }) },
      pago: { create: async () => { pagoCreado = true; return { id: 1 }; } },
    };
    const servicio = cargar('../src/services/checkoutService.js', {
      '../config/prisma': { $transaction: async (operar) => {
        const resultado = await operar(tx);
        confirmado = true;
        return resultado;
      } },
      '../config/mongo': { conectar: async () => {} },
      '../models/mongo/Producto': {
        find: () => ({ select: () => ({ lean: async () => [{ producto_id: 3, estado: 'activo' }] }) }),
        updateOne: async () => { cacheEscrita = true; },
      },
      './cartService': { bloquearUsuario: async () => {}, invalidarCache: async () => { cacheEscrita = true; }, avanzarVersion: async () => {} },
      './checkoutIntentoService': { reutilizado: () => false },
      './productoService': { verificarNoEsPropio: async () => {}, verificarVendedoresActivos: async () => {} },
      './compromisoService': { exigirCompromiso: async () => ({ requerido: false, aceptadoEn: null }) },
      // fraudeSyncService ahora lee el correo de MySQL (prisma): sin este doble
      // el módulo real abriría una conexión en una prueba aislada.
      './fraudeSyncService': { registrarCompra: async () => {} },
      './ventasOutboxService': { encolarCompra: async (mismoTx) => {
        assert.equal(mismoTx, tx);
        assert.equal(pagoCreado, true);
        throw new Error('outbox no disponible');
      } },
    });
    await assert.rejects(servicio[variante]({
      usuarioId: 7, direccionId: 1, metodoPagoId: 1, items: [{ productoId: 3, cantidad: 2 }],
      productoId: 3, cantidad: 2, precioUnitario: 10,
    }), /outbox no disponible/);
    assert.equal(confirmado, false);
    assert.equal(cacheEscrita, false);
  });
}
