const test = require('node:test');
const assert = require('node:assert/strict');
const { cargar } = require('./redisHelpers');

const datos = { direccionId: 1, metodoPagoId: 2, aceptaNoReventa: false,
  items: [{ productoId: 3, cantidad: 1, precioEsperado: 20 }] };
const respuesta = { compra: { id: 40, compra_detalles: [{ id: 8 }] }, pago: { id: 50, estado: 'aprobado' } };

function escenario() {
  let estado = { intentos: new Map(), sesiones: new Map(), version: 0, stock: 5,
    carrito: [{ id_producto: 3, cantidad: 1 }], compras: [] };
  let cola = Promise.resolve();
  let perderRespuesta = false;
  let redisCaido = false;
  let cupo = 2;
  let devoluciones = 0;
  const reservas = new Map();
  const db = {
    $queryRaw: async () => [],
    usuarios: { findUnique: async () => ({ carrito_version: estado.version }) },
    carrito: { findMany: async () => estado.carrito },
    inventario: { findMany: async () => [{ id_producto: 3, precio: 20 }] },
    checkout_sesion: {
      findUnique: async ({ where }) => estado.sesiones.get(JSON.stringify(where.id_usuario_ambito)),
      upsert: async ({ where, create, update }) => {
        const k = JSON.stringify(where.id_usuario_ambito);
        estado.sesiones.set(k, estado.sesiones.has(k) ? { ...estado.sesiones.get(k), ...update } : create);
      },
    },
    checkout_intento: {
      findUnique: async ({ where }) => estado.intentos.get(where.id) || null,
      create: async ({ data }) => {
        const i = { estado: 'pendiente', datos_hash: null, reserva: null, version_carrito: null,
          actualizado_en: new Date(), compensado: false, ...data };
        estado.intentos.set(i.id, i);
        return i;
      },
      update: async ({ where, data }) => {
        const i = { ...estado.intentos.get(where.id), ...data, actualizado_en: new Date() };
        estado.intentos.set(i.id, i);
        return i;
      },
      findMany: async () => [...estado.intentos.values()].filter((i) =>
        (i.estado === 'fallido' && !i.compensado) || (i.estado === 'pendiente' && i.actualizado_en < new Date(Date.now() - 15 * 60000))),
    },
    async $transaction(fn) {
      const anterior = cola;
      let soltar;
      cola = new Promise((resolve) => { soltar = resolve; });
      await anterior;
      const snapshot = structuredClone(estado);
      try {
        let result;
        try { result = await fn(db); }
        catch (err) { estado = snapshot; throw err; }
        if (perderRespuesta) { perderRespuesta = false; throw new Error('Respuesta del COMMIT perdida'); }
        return result;
      } finally { soltar(); }
    },
  };
  const redis = {
    async reservarOfertaIdempotente(stock, id, inicial, vence, cantidad) {
      if (redisCaido) throw new Error('Redis caído');
      if (reservas.get(id)?.estado === 'devuelta') return -2;
      if (reservas.has(id)) return 1;
      if (cupo < cantidad) return -1;
      cupo -= cantidad;
      reservas.set(id, { estado: 'reservada', cantidad });
      return 1;
    },
    async devolverReservaOferta(stock, id) {
      if (redisCaido) throw new Error('Redis caído');
      const r = reservas.get(id);
      if (r?.estado === 'reservada') { cupo += r.cantidad; devoluciones++; }
      reservas.set(id, { estado: 'devuelta' });
    },
  };
  const servicio = cargar('../src/services/checkoutIntentoService.js', {
    '../config/prisma': db, '../config/redis': { conectar: () => redis },
  });
  return { servicio, db, redis, estado: () => estado, cupo: () => cupo, devoluciones: () => devoluciones,
    perderRespuesta: () => { perderRespuesta = true; }, redisCaido: (v) => { redisCaido = v; },
    async comprar() {
      estado.stock--;
      estado.carrito = [];
      estado.version++;
      estado.compras.push(respuesta.compra);
      return respuesta;
    },
  };
}

test('dos ventanas preparan el mismo intento para la versión del carrito', async () => {
  const e = escenario();
  const [a, b] = await Promise.all([e.servicio.preparar(7), e.servicio.preparar(7)]);
  assert.equal(a.intentoId, b.intentoId);
  assert.equal(e.estado().intentos.size, 1);
});

test('confirmaciones normales simultáneas crean un solo pedido y descuentan una vez', async () => {
  const e = escenario();
  const i = await e.servicio.preparar(7);
  const ejecutar = () => e.servicio.transaccion({ usuarioId: 7, intentoId: i.intentoId, datos }, () => e.comprar());
  const [a, b] = await Promise.all([ejecutar(), ejecutar()]);
  assert.equal(a.compra.id, b.compra.id);
  assert.equal(e.estado().compras.length, 1);
  assert.equal(e.estado().stock, 4);
  assert.equal(e.servicio.reutilizado(b), true);
});

test('COMMIT confirmado y respuesta perdida se recupera sin depender del carrito vacío ni Mongo', async () => {
  const e = escenario();
  const i = await e.servicio.preparar(7);
  e.perderRespuesta();
  await assert.rejects(e.servicio.transaccion({ usuarioId: 7, intentoId: i.intentoId, datos }, () => e.comprar()), /COMMIT/);
  assert.equal(e.estado().carrito.length, 0);
  const recuperada = await e.servicio.recuperar(7, i.intentoId, datos);
  assert.equal(recuperada.compra.id, 40);
  assert.equal(e.estado().compras.length, 1);
});

test('una caída antes del COMMIT revierte pedido y estado; el mismo intento se puede reanudar', async () => {
  const e = escenario();
  const i = await e.servicio.preparar(7);
  const args = { usuarioId: 7, intentoId: i.intentoId, datos };
  await assert.rejects(e.servicio.transaccion(args, async () => { await e.comprar(); throw new Error('caída'); }), /caída/);
  assert.equal(e.estado().compras.length, 0);
  assert.equal(e.estado().stock, 5);
  assert.equal((await e.servicio.consultar(7, i.intentoId)).estado, 'pendiente');
  await e.servicio.transaccion(args, () => e.comprar());
  assert.equal(e.estado().compras.length, 1);
});

test('modificar el carrito invalida el intento anterior aunque se repongan los mismos productos', async () => {
  const e = escenario();
  const i = await e.servicio.preparar(7);
  e.estado().version += 2;
  await assert.rejects(e.servicio.transaccion({ usuarioId: 7, intentoId: i.intentoId, datos }, () => assert.fail('no comprar')),
    (err) => err.codigo === 'CHECKOUT_CARRITO_CAMBIO');
  const nuevo = await e.servicio.preparar(7);
  assert.notEqual(nuevo.intentoId, i.intentoId);
});

test('otra cuenta no puede consultar un intento y una clave completada no acepta otros datos', async () => {
  const e = escenario();
  const i = await e.servicio.preparar(7);
  await assert.rejects(e.servicio.consultar(8, i.intentoId), (err) => err.status === 404);
  await e.servicio.transaccion({ usuarioId: 7, intentoId: i.intentoId, datos }, () => e.comprar());
  await assert.rejects(e.servicio.recuperar(7, i.intentoId, { ...datos, direccionId: 9 }),
    (err) => err.codigo === 'CHECKOUT_DATOS_DISTINTOS');
});

async function flash(e) {
  const i = await e.servicio.preparar(7, { productoId: 3, ofertaVersion: 'v1' });
  const solicitud = { productoId: 3, cantidad: 1, direccionId: 1, metodoPagoId: 2, precioEsperado: 15 };
  const r = { version: 'v1', claveStock: 'oferta:3:stock:v1', cantidad: 1, stockInicial: 2, vence: Math.floor(Date.now() / 1000) + 1000 };
  await e.servicio.registrarReserva(7, i.intentoId, solicitud, r);
  const args = { usuarioId: 7, intentoId: i.intentoId, datos: solicitud,
    reservar: () => e.redis.reservarOfertaIdempotente(r.claveStock, `checkout:reserva:${i.intentoId}`, 2, r.vence, 1) };
  return { i, solicitud, args };
}

test('dos confirmaciones flash crean un pedido y reservan un solo cupo', async () => {
  const e = escenario();
  const { args } = await flash(e);
  const [a, b] = await Promise.all([e.servicio.transaccion(args, () => e.comprar()), e.servicio.transaccion(args, () => e.comprar())]);
  assert.equal(a.compra.id, b.compra.id);
  assert.equal(e.cupo(), 1);
  assert.equal(e.estado().compras.length, 1);
});

test('caída tras reservar Redis y rollback MySQL: reanudar no vuelve a descontar', async () => {
  const e = escenario();
  const { args } = await flash(e);
  await assert.rejects(e.servicio.transaccion(args, () => { throw new Error('proceso interrumpido'); }));
  assert.equal(e.cupo(), 1);
  await e.servicio.transaccion(args, () => e.comprar());
  assert.equal(e.cupo(), 1);
  assert.equal(e.estado().compras.length, 1);
});

test('fallo flash definitivo compensa una vez y prohíbe confirmar esa reserva después', async () => {
  const e = escenario();
  const { args, i } = await flash(e);
  await assert.rejects(e.servicio.transaccion(args, () => { throw new Error('sin inventario'); }));
  await Promise.all([e.servicio.resolverFallo(7, i.intentoId, new Error('sin inventario')), e.servicio.resolverFallo(7, i.intentoId, new Error('sin inventario'))]);
  assert.equal(e.cupo(), 2);
  assert.equal(e.devoluciones(), 1);
  await assert.rejects(e.servicio.transaccion(args, () => assert.fail('no comprar')), (err) => err.codigo === 'CHECKOUT_FALLIDO');
});

test('un COMMIT flash de resultado incierto no devuelve el cupo de una compra confirmada', async () => {
  const e = escenario();
  const { args, i } = await flash(e);
  e.perderRespuesta();
  await assert.rejects(e.servicio.transaccion(args, () => e.comprar()));
  const r = await e.servicio.resolverFallo(7, i.intentoId, new Error('timeout'));
  assert.equal(r.compra.id, 40);
  assert.equal(e.cupo(), 1);
  assert.equal(e.devoluciones(), 0);
});

test('Redis caído durante la compensación conserva el pendiente y el worker lo recupera', async () => {
  const e = escenario();
  const { args, i } = await flash(e);
  await assert.rejects(e.servicio.transaccion(args, () => { throw new Error('fallo SQL'); }));
  e.redisCaido(true);
  await e.servicio.resolverFallo(7, i.intentoId, new Error('fallo SQL'));
  assert.equal(e.estado().intentos.get(i.intentoId).compensado, false);
  e.redisCaido(false);
  await e.servicio.reconciliar();
  assert.equal(e.estado().intentos.get(i.intentoId).compensado, true);
  assert.equal(e.cupo(), 2);
});

test('dos ventanas que piden otra compra explícita reciben el mismo intento nuevo', async () => {
  const e = escenario();
  const { args, i } = await flash(e);
  await e.servicio.transaccion(args, () => e.comprar());
  const preparar = () => e.servicio.preparar(7, { productoId: 3, ofertaVersion: 'v1', anteriorIntentoId: i.intentoId });
  const [a, b] = await Promise.all([preparar(), preparar()]);
  assert.equal(a.intentoId, b.intentoId);
  assert.notEqual(a.intentoId, i.intentoId);
});

test('el barrido recupera una reserva abandonada tras la caída del proceso', async () => {
  const e = escenario();
  const { args, i } = await flash(e);
  await assert.rejects(e.servicio.transaccion(args, () => { throw new Error('caída'); }));
  e.estado().intentos.get(i.intentoId).actualizado_en = new Date(Date.now() - 16 * 60000);
  await e.servicio.reconciliar();
  assert.equal((await e.servicio.consultar(7, i.intentoId)).estado, 'fallido');
  assert.equal(e.cupo(), 2);
});
