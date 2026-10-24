require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const neo4j = require('../src/config/neo4j');
const elastic = require('../src/config/elasticsearch');
const redisConfig = require('../src/config/redis');
// consultarFraude/checkout leen el catálogo y Mongoose necesita Categoria registrado.
require('../src/models/mongo/Categoria');
const Producto = require('../src/models/mongo/Producto');
const app = require('../src/app');
const { checkout } = require('../src/services/checkoutService');
const { consultarFraude } = require('../src/services/fraudeService');
const bloqueo = require('../src/services/bloqueoService');
const suspension = require('../src/services/suspensionService');
const restriccion = require('../src/services/restriccionService');
const limitePedidos = require('../src/services/limitePedidosService');
const productoService = require('../src/services/productoService');
const ofertaFlash = require('../src/services/ofertaFlashService');
const ofertaDatos = require('../src/services/ofertaDatosService');
const { indexarProducto } = require('../src/services/busquedaSyncService');
const { afirmar, prepararCuenta, asegurarProducto, conProductoActivo } = require('./lib/datosPrueba');

// Evidencia, contra un Redis, un MySQL, un Mongo, un Elasticsearch y un Neo4j de verdad,
// de la RESPUESTA ESCALONADA al fraude (IA/PLAN-NEO4J-DETECCION-FRAUDE.md §21):
//
//   1. un vendedor suspendido deja de mostrarse y de poder comprarse (catálogo, buscador,
//      sugerencias, detalle, carrito, pedido, oferta flash) y VUELVE solo: al liberarlo
//      un administrador, al vencer su suspensión;
//   2. un tope de pedidos por hora (contador en Redis) rechaza el pedido de más ANTES de
//      completarlo, atómicamente, y un pedido que falla no gasta el cupo;
//   3. una cuenta con límites suaves (hallazgo «posible») compra con su contraseña, un
//      tope de monto y menos pedidos por hora, y un administrador puede quitarlos;
//   4. el barrido pone «posible» bajo vigilancia y «alta» en suspensión, y si un
//      «posible» sube a «alta» la cuenta se suspende sin perder su vigilancia.
//
// Siembra sus propias cuentas sintéticas (`escalonada.*`) y un producto activo del
// vendedor, con checkout() real. Es idempotente: antes de empezar borra los casos de ESAS
// cuentas y repone el stock, y al terminar las deja libres y el producto inactivo.
// Cada corrida compra unos pocos pedidos de prueba de Q30 (se conservan, como en los demás
// scripts, para mantener pedidos/outbox/fraude consistentes).
//
// Los controles de pedidos viven en las rutas HTTP, así que las pruebas pasan por un
// Express de verdad en un puerto libre; sus topes se fijan en process.env de ESTE proceso
// (la configuración se lee en cada petición) y no tocan el backend que esté corriendo.
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HORA = 3600000;
const CONTRASENA = 'Password123!';
const TITULO = '[PRUEBA escalonada] Zorrillo de peluche';
const ATRIBUTO = { nombre: 'Material', valor: 'Peluche-escalonada' };
const PRECIO = 30;

async function main() {
  const redis = redisConfig.conectar('admin');
  const cliente = await elastic.conectar();

  // --- 0) Datos de prueba ---
  const admin = await prepararCuenta('escalonada.admin@example.com', 'Escalonada Admin', 'tok_escalonada_admin', { rol: 'administrador' });
  const vendedor = await prepararCuenta('escalonada.vendedor@example.com', 'Escalonada Vendedor', 'tok_escalonada_vendedor', { rol: 'vendedor' });
  const comprador = await prepararCuenta('escalonada.comprador@example.com', 'Escalonada Comprador', 'tok_escalonada_comprador');
  // Dos cuentas con el MISMO nombre y fechas de nacimiento distintas: «posible», no «alta».
  const gemeloA = await prepararCuenta('escalonada.homonimo.a@example.com', 'Escalonada Homonimo', 'tok_escalonada_homonimo_a', { nacimiento: '1990-04-04' });
  const gemeloB = await prepararCuenta('escalonada.homonimo.b@example.com', 'Escalonada Homonimo', 'tok_escalonada_homonimo_b', { nacimiento: '1991-05-05' });
  const ids = { admin: admin.usuario.id_usuario, vendedor: vendedor.usuario.id_usuario, comprador: comprador.usuario.id_usuario, a: gemeloA.usuario.id_usuario, b: gemeloB.usuario.id_usuario };
  const todos = Object.values(ids);
  const producto = await asegurarProducto(vendedor.usuario, TITULO, PRECIO, { cantidad: 100, atributos: [ATRIBUTO] });

  // Los dos homónimos compran una vez cada uno (el grafo une a las cuentas que COMPRAN),
  // con el producto activo solo durante su compra — antes de dejarlo activo para el resto.
  const ordenes = (id) => prisma.compra.count({ where: { id_usuario: id } });
  for (const cuenta of [gemeloA, gemeloB]) {
    if ((await ordenes(cuenta.usuario.id_usuario)) === 0) {
      await conProductoActivo(producto, () =>
        checkout({ usuarioId: cuenta.usuario.id_usuario, direccionId: cuenta.direccion.id, metodoPagoId: cuenta.metodoPago.id, items: [{ productoId: producto.id, cantidad: 1 }] })
      );
    }
  }

  // Parte de cero: sin casos, candados ni contadores de una corrida anterior; el stock
  // repuesto en las DOS bases (MySQL es la autoridad, Mongo su copia), las fechas de
  // nacimiento como las sembró y el producto ACTIVO e indexado en el buscador.
  await prisma.bloqueo_cuenta.deleteMany({ where: { id_usuario: { in: todos } } });
  for (const id of todos) {
    await suspension.levantar(id);
    await restriccion.candado.levantar(id);
    await redis.del(`limite:pedidos:${id}`, `reauth:intentos:${id}`);
  }
  await prisma.usuarios.update({ where: { id_usuario: ids.b }, data: { fecha_nacimiento: new Date('1991-05-05') } });
  await prisma.inventario.update({ where: { id_producto: producto.id }, data: { precio: PRECIO, cantidad: 100 } });
  await Producto.updateOne({ producto_id: producto.id }, { $set: { estado: 'activo', 'inventario.precio': PRECIO, 'inventario.cantidad': 100, oferta_flash: null } });
  await ofertaDatos.invalidar(producto.id);
  await redis.del(`oferta:${producto.id}:stock`);
  const indexar = async () => {
    await indexarProducto(await productoService.obtener(producto.id));
    await cliente.indices.refresh({ index: elastic.indice() });
  };
  await indexar();

  // Un Express de verdad en un puerto libre: las rutas, el middleware y el login reales.
  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}/api`;
  const http = async (ruta, { metodo = 'GET', token, body } = {}) => {
    const res = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, cuerpo: await res.json().catch(() => null), reintentar: res.headers.get('retry-after') };
  };
  const tokenDe = (cuenta, rol) => jwt.sign({ id_usuario: cuenta.usuario.id_usuario, rol_id: cuenta.usuario.rol_id, rol }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const tokenAdmin = tokenDe(admin, 'administrador');
  const tokenVendedor = tokenDe(vendedor, 'vendedor');
  const tokenComprador = tokenDe(comprador, 'comprador');
  const stock = async () => (await prisma.inventario.findUnique({ where: { id_producto: producto.id } })).cantidad;
  const contador = async (id) => Number((await redis.get(`limite:pedidos:${id}`)) ?? 0);
  const pedido = (cuenta, token, extra = {}, { cantidad = 1, direccionId = cuenta.direccion.id } = {}) =>
    http('/checkout', {
      metodo: 'POST',
      token,
      body: { direccionId, metodoPagoId: cuenta.metodoPago.id, items: [{ productoId: producto.id, cantidad, precioEsperado: PRECIO }], ...extra },
    });

  try {
    // ════════ 1) Un vendedor suspendido se oculta; al levantarse, vuelve ════════
    process.env.LIMITE_PEDIDOS_HORA = '0'; // los topes no son lo que se prueba acá
    // Qué ve el PÚBLICO (sin sesión) de este producto, en cada lugar donde podría aparecer.
    const visibles = async () => {
      const [catalogo, busqueda, sugerencias, detalle] = await Promise.all([
        http('/productos?q=escalonada'),
        http('/busqueda?q=zorrillo%20escalonada'),
        http('/busqueda/sugerencias?q=prueba%20escalonada'),
        http(`/productos/${producto.id}`),
      ]);
      return {
        catalogo: catalogo.cuerpo.some((p) => p.id === producto.id),
        busqueda: busqueda.cuerpo.resultados.some((p) => p.id === producto.id),
        faceta: (busqueda.cuerpo.facetas?.[ATRIBUTO.nombre] ?? []).includes(ATRIBUTO.valor),
        sugerencia: sugerencias.cuerpo.sugerencias.includes(TITULO),
        detalle: detalle.status === 200,
      };
    };
    const todo = (v, valor) => Object.values(v).every((x) => x === valor);

    afirmar(todo(await visibles(), true), `con el vendedor activo el producto debe verse en el catálogo, el buscador (y su faceta), las sugerencias y el detalle: ${JSON.stringify(await visibles())}`);
    await http('/carrito', { metodo: 'DELETE', token: tokenComprador });
    afirmar((await http('/carrito/items', { metodo: 'POST', token: tokenComprador, body: { productoId: producto.id, cantidad: 1 } })).status === 201, 'el comprador agrega el producto al carrito');
    await ofertaFlash.actualizar({ id_usuario: ids.vendedor, rol: 'vendedor' }, producto.id, {
      activo: true,
      precio_oferta: 20,
      stock_oferta: 5,
      vigente_desde: new Date(Date.now() - 60000).toISOString(),
      vigente_hasta: new Date(Date.now() + 2 * HORA).toISOString(),
    });
    afirmar((await http(`/ofertas/${producto.id}/stock`)).cuerpo.activo === true, 'y el producto tiene una oferta flash activa');
    console.log('OK 1a: con el vendedor activo, el producto se ve en el catálogo, el buscador (con su faceta), las sugerencias, el detalle, el carrito y la oferta flash.');

    // Suspensión por un hallazgo de confianza alta (el caso lo abre el mismo servicio que el barrido).
    const caso = await bloqueo.abrirCaso({ usuarioId: ids.vendedor, huella: `prueba:ocultar:${Date.now()}`, senal: 'gasto_anomalo', motivo: 'Verificación: el vendedor suspendido deja de mostrarse', duracionMs: 24 * HORA });
    afirmar(caso.creado, 'la suspensión de prueba debe abrirse');
    const oculto = await visibles();
    afirmar(todo(oculto, false), `suspendido el vendedor, NADA suyo debe verse: ${JSON.stringify(oculto)}`);
    afirmar((await http(`/productos/${producto.id}`)).status === 404, 'el detalle responde 404 al público: para él, el producto no existe');
    afirmar((await http(`/productos?vendedorId=${ids.vendedor}`)).cuerpo.length === 0, 'ni filtrando por el vendedor');
    const delAdmin = await http(`/productos/${producto.id}`, { token: tokenAdmin });
    afirmar(delAdmin.status === 200 && delAdmin.cuerpo.vendedor_suspendido === true, 'un administrador SÍ lo abre, marcado como de vendedor suspendido');
    const listaAdmin = (await http('/productos?q=escalonada', { token: tokenAdmin })).cuerpo.find((p) => p.id === producto.id);
    afirmar(listaAdmin?.vendedor_suspendido === true, 'y en su listado completo aparece marcado');
    const revisado = (await http('/carrito/revisar', { metodo: 'POST', token: tokenComprador })).cuerpo.items.find((i) => i.producto.id === producto.id);
    afirmar(revisado && revisado.disponible === false, 'en el carrito de quien ya lo tenía, queda como no disponible (no se borra)');
    const alCarrito = await http('/carrito/items', { metodo: 'POST', token: tokenComprador, body: { productoId: producto.id, cantidad: 1 } });
    afirmar(alCarrito.status === 400 && /no está disponible/.test(alCarrito.cuerpo.error), `y no se puede agregar de nuevo (llegó ${alCarrito.status})`);
    const antesStock = await stock();
    const antesPedidos = await ordenes(ids.comprador);
    const compra = await pedido(comprador, tokenComprador);
    afirmar(compra.status === 409 && /no disponibles/.test(compra.cuerpo.error), `el pedido se rechaza con 409 (llegó ${compra.status}: ${compra.cuerpo?.error})`);
    afirmar((await stock()) === antesStock && (await ordenes(ids.comprador)) === antesPedidos, 'sin crear un pedido ni tocar el stock');
    afirmar((await http(`/ofertas/${producto.id}/stock`)).status === 404, 'la oferta flash "no existe" para el público');
    const flash = await http(`/ofertas/${producto.id}/comprar`, { metodo: 'POST', token: tokenComprador, body: { cantidad: 1, direccionId: comprador.direccion.id, metodoPagoId: comprador.metodoPago.id, precioEsperado: 20 } });
    afirmar(flash.status === 409 && (await redis.get(`oferta:${producto.id}:stock`)) === null, `y comprarla da 409 (llegó ${flash.status}) sin gastar cupo de Redis`);
    console.log('OK 1b: suspendido el vendedor, su producto desaparece del catálogo, el buscador (y facetas), las sugerencias, el detalle y la oferta flash; no se compra; un administrador lo sigue viendo, marcado.');

    // Liberado por un administrador ("perdonado"): vuelve al instante.
    const liberada = await http(`/admin/bloqueos/${ids.vendedor}/liberar`, { metodo: 'POST', token: tokenAdmin, body: { nota: 'Verificación: se perdona' } });
    afirmar(liberada.status === 200 && liberada.cuerpo.casosCerrados === 1, `liberar debe cerrar el caso (llegó ${liberada.status})`);
    const vuelto = await visibles();
    afirmar(todo(vuelto, true), `liberado el vendedor, todo vuelve en el mismo instante: ${JSON.stringify(vuelto)}`);
    afirmar((await http('/carrito/revisar', { metodo: 'POST', token: tokenComprador })).cuerpo.items.find((i) => i.producto.id === producto.id)?.disponible === true, 'el carrito vuelve a tenerlo disponible');
    afirmar((await http(`/ofertas/${producto.id}/stock`)).cuerpo.activo === true, 'y la oferta flash vuelve, con su cupo intacto');
    afirmar((await http(`/productos/${producto.id}`, { token: tokenAdmin })).cuerpo.vendedor_suspendido === undefined, 'sin marca de oculto para el administrador');
    console.log('OK 1c: al liberar a un administrador, todo vuelve en el mismo instante (catálogo, buscador, carrito, oferta).');

    // Y sin que nadie haga nada: vence el TTL del candado y el producto reaparece.
    await bloqueo.abrirCaso({ usuarioId: ids.vendedor, huella: `prueba:ocultar:ttl:${Date.now()}`, senal: 'gasto_anomalo', motivo: 'Verificación: reaparece solo al vencer', duracionMs: 2500 });
    const desde = Date.now();
    afirmar(todo(await visibles(), false), 'mientras corre el TTL, el producto está oculto');
    let volvioA = null;
    while (Date.now() - desde < 9000) {
      await esperar(300);
      if ((await visibles()).catalogo) {
        volvioA = Date.now() - desde;
        break;
      }
    }
    afirmar(volvioA !== null && volvioA <= 2500 + 3600, `al vencer el TTL el producto reaparece solo, a lo sumo ~3 s después (el memo del servidor); reapareció a los ${volvioA} ms`);
    afirmar(todo(await visibles(), true), 'y vuelve en todos los lugares');
    console.log(`OK 1d: sin que nadie lo libere, el producto reapareció solo ${volvioA} ms después de iniciar una suspensión de 2500 ms.`);
    await ofertaFlash.actualizar({ id_usuario: ids.vendedor, rol: 'vendedor' }, producto.id, { activo: false });
    await bloqueo.reconciliar();

    // ════════ 2) Prevención: tope de pedidos por hora ════════
    process.env.LIMITE_PEDIDOS_HORA = '2';
    // Un pedido que FALLA no gasta el cupo: tres intentos con una dirección que no existe.
    for (let i = 0; i < 3; i += 1) {
      const fallido = await pedido(admin, tokenAdmin, { aceptaNoReventa: true }, { direccionId: 2147483000 });
      afirmar(fallido.status >= 400 && fallido.status !== 429, `un pedido con una dirección inexistente debe fallar en el servicio, no por el tope (llegó ${fallido.status})`);
    }
    await esperar(200); // el cupo se devuelve al terminar la respuesta, un instante después de recibirla
    afirmar((await contador(ids.admin)) === 0, `tres pedidos fallidos no gastan cupo (contador: ${await contador(ids.admin)})`);
    // Dos pedidos buenos pasan; el tercero se rechaza ANTES de completarse.
    const inicioPedidos = await ordenes(ids.admin);
    const inicioStock = await stock();
    for (let i = 1; i <= 2; i += 1) {
      const bueno = await pedido(admin, tokenAdmin, { aceptaNoReventa: true });
      afirmar(bueno.status === 201 && bueno.cuerpo.compra?.id, `el pedido ${i} de 2 debe completarse (llegó ${bueno.status}: ${bueno.cuerpo?.error})`);
    }
    const ttlMs = await redis.pttl(`limite:pedidos:${ids.admin}`);
    afirmar(ttlMs > 0 && ttlMs <= HORA, `el contador es una ventana de una hora (TTL ${Math.round(ttlMs / 1000)} s)`);
    const tercero = await pedido(admin, tokenAdmin, { aceptaNoReventa: true });
    afirmar(tercero.status === 429 && tercero.cuerpo.codigo === 'LIMITE_PEDIDOS', `el tercer pedido de la hora se rechaza con 429 (llegó ${tercero.status})`);
    afirmar(Number(tercero.reintentar) > 0 && Number(tercero.reintentar) <= 3600 && tercero.cuerpo.reintentarEnSegundos === Number(tercero.reintentar), 'con Retry-After y cuánto falta, en segundos');
    afirmar(/máximo de 2 pedidos por hora/.test(tercero.cuerpo.error), 'y un mensaje que lo explica');
    afirmar((await ordenes(ids.admin)) === inicioPedidos + 2 && (await stock()) === inicioStock - 2, 'el rechazado no creó ningún pedido ni descontó stock');
    console.log('OK 2a: el tope por hora rechaza el pedido de más con 429 + Retry-After antes de completarlo; los pedidos fallidos no gastan cupo.');

    // Atómico: con 5 pedidos A LA VEZ y un tope de 2, pasan exactamente 2.
    await redis.del(`limite:pedidos:${ids.admin}`);
    const simultaneos = await Promise.all(Array.from({ length: 5 }, () => pedido(admin, tokenAdmin, { aceptaNoReventa: true })));
    const exitosos = simultaneos.filter((r) => r.status === 201).length;
    const rechazados = simultaneos.filter((r) => r.status === 429).length;
    afirmar(exitosos === 2 && rechazados === 3, `5 pedidos simultáneos con tope 2: deben pasar 2 y rechazarse 3 (pasaron ${exitosos}, se rechazaron ${rechazados}; otros: ${simultaneos.map((r) => r.status)})`);
    afirmar((await ordenes(ids.admin)) === inicioPedidos + 4 && (await stock()) === inicioStock - 4, 'y solo se crearon (y descontaron) los 2 pedidos admitidos');
    // El mismo contador, directo contra Redis: 20 reservas a la vez con tope 5 → exactamente 5.
    const clavePrueba = 999001;
    await redis.del(`limite:pedidos:${clavePrueba}`);
    const reservas = await Promise.all(Array.from({ length: 20 }, () => limitePedidos.reservar(clavePrueba, 5)));
    afirmar(reservas.filter((r) => r.admitido).length === 5 && (await contador(clavePrueba)) === 5, `20 reservas simultáneas con tope 5: exactamente 5 admitidas y el contador queda en 5 (quedó en ${await contador(clavePrueba)})`);
    await Promise.all(Array.from({ length: 12 }, () => limitePedidos.liberar(clavePrueba)));
    afirmar((await contador(clavePrueba)) === 0, 'liberar nunca baja de cero');
    await redis.del(`limite:pedidos:${clavePrueba}`);
    console.log('OK 2b: con pedidos simultáneos pasan exactamente los que caben en el tope (INCR + EXPIRE atómico en un script Lua).');

    // Apagado y configuración inválida: no frenan nada (fallan abiertos).
    for (const valor of ['0', 'abc']) {
      process.env.LIMITE_PEDIDOS_HORA = valor;
      await redis.del(`limite:pedidos:${ids.admin}`);
      const sin = await pedido(admin, tokenAdmin, { aceptaNoReventa: true }, { direccionId: 2147483000 });
      afirmar(sin.status !== 429 && (await redis.exists(`limite:pedidos:${ids.admin}`)) === 0, `LIMITE_PEDIDOS_HORA="${valor}" no frena ni cuenta nada (0 = sin tope; un valor inválido falla abierto)`);
    }
    console.log('OK 2c: 0 apaga el tope y una variable mal escrita falla abierta (no frena a nadie).');

    // ════════ 3) Una cuenta con límites suaves ════════
    process.env.LIMITE_PEDIDOS_HORA = '0';
    process.env.RESTRICCION_MONTO_MAXIMO = '100';
    process.env.RESTRICCION_PEDIDOS_HORA = '1';
    const cfg = restriccion.configuracion();
    const sinPedidos = await ordenes(ids.comprador);
    const abierto = await bloqueo.abrirCaso({ usuarioId: ids.comprador, huella: `prueba:vigilancia:${Date.now()}`, senal: 'rafaga_gasto', motivo: 'Verificación: hallazgo «posible» que deja a la cuenta bajo vigilancia', tipo: 'restriccion', duracionMs: cfg.duracionMs });
    afirmar(abierto.creado, 'el caso de restricción debe abrirse');
    const ttlRestriccion = await redis.pttl(`restriccion:${ids.comprador}`);
    afirmar(ttlRestriccion > cfg.duracionMs - 5 * 60000 && ttlRestriccion <= cfg.duracionMs, `restriccion:{id} en Redis dura lo configurado (${cfg.horas} h): ${Math.round(ttlRestriccion / 60000)} min`);
    afirmar((await redis.exists(`bloqueo:${ids.comprador}`)) === 0, 'y la cuenta NO está suspendida');
    afirmar((await http('/auth/me', { token: tokenComprador })).status === 200, 'sigue entrando y usando el sitio');

    const sinClave = await pedido(comprador, tokenComprador);
    afirmar(sinClave.status === 403 && sinClave.cuerpo.codigo === 'REQUIERE_CONTRASENA', `sin contraseña, el pedido se rechaza con 403 REQUIERE_CONTRASENA (llegó ${sinClave.status}: ${sinClave.cuerpo?.codigo})`);
    const mala = await pedido(comprador, tokenComprador, { contrasena: 'incorrecta' });
    afirmar(mala.status === 403 && mala.cuerpo.codigo === 'CONTRASENA_INCORRECTA', `con una contraseña incorrecta, 403 CONTRASENA_INCORRECTA (llegó ${mala.status})`);
    await esperar(200);
    afirmar((await contador(ids.comprador)) === 0 && (await ordenes(ids.comprador)) === sinPedidos, 'ninguno de los dos gastó cupo ni creó pedido');

    const antes = await stock();
    const grande = await pedido(comprador, tokenComprador, { contrasena: CONTRASENA }, { cantidad: 4 }); // 4 × Q30 = Q120 > Q100
    afirmar(grande.status === 403 && grande.cuerpo.codigo === 'LIMITE_MONTO', `un pedido de Q120 con tope de Q100 se rechaza con 403 LIMITE_MONTO (llegó ${grande.status}: ${grande.cuerpo?.codigo})`);
    afirmar(/Q100/.test(grande.cuerpo.error) && /Q120/.test(grande.cuerpo.error), 'el mensaje dice el tope y lo que suma el pedido');
    await esperar(200);
    afirmar((await stock()) === antes && (await ordenes(ids.comprador)) === sinPedidos && (await contador(ids.comprador)) === 0, 'sin pedido, sin descontar stock y devolviendo el cupo de la hora');
    const chico = await pedido(comprador, tokenComprador, { contrasena: CONTRASENA }, { cantidad: 3 }); // Q90 ≤ Q100
    afirmar(chico.status === 201, `con la contraseña y dentro del tope (Q90), el pedido pasa (llegó ${chico.status}: ${chico.cuerpo?.error})`);
    afirmar(Number((await prisma.compra.findUnique({ where: { id: chico.cuerpo.compra.id } })).total) === 90, 'y se cobra lo de siempre');
    const segundo = await pedido(comprador, tokenComprador, { contrasena: CONTRASENA });
    afirmar(segundo.status === 429 && segundo.cuerpo.codigo === 'LIMITE_PEDIDOS' && /en revisión/.test(segundo.cuerpo.error), `con un tope propio de 1 pedido por hora, el segundo se rechaza con 429 y lo explica (llegó ${segundo.status})`);
    console.log('OK 3a: una cuenta bajo vigilancia entra y compra, pero con su contraseña, un tope de monto por pedido y menos pedidos por hora.');

    // La contraseña no es un oráculo: 5 intentos fallidos y el siguiente, aunque sea el correcto, espera.
    await redis.del(`reauth:intentos:${ids.comprador}`, `limite:pedidos:${ids.comprador}`);
    for (let i = 0; i < 5; i += 1) {
      afirmar((await pedido(comprador, tokenComprador, { contrasena: `mala${i}` })).status === 403, `intento fallido ${i + 1} de 5`);
    }
    const bloqueada = await pedido(comprador, tokenComprador, { contrasena: CONTRASENA });
    afirmar(bloqueada.status === 429 && bloqueada.cuerpo.codigo === 'DEMASIADOS_INTENTOS' && Number(bloqueada.reintentar) > 0, `tras 5 intentos fallidos, hasta la contraseña correcta recibe 429 DEMASIADOS_INTENTOS (llegó ${bloqueada.status})`);
    await redis.del(`reauth:intentos:${ids.comprador}`);
    console.log('OK 3b: tras 5 contraseñas incorrectas seguidas el pedido espera (429 + Retry-After): el endpoint no sirve para adivinarla.');

    // Un administrador nunca queda bajo vigilancia, aunque haya un candado a su nombre.
    await restriccion.candado.bloquear(ids.admin, 60000);
    const deAdmin = await pedido(admin, tokenAdmin, { aceptaNoReventa: true }, { direccionId: 2147483000 });
    afirmar(deAdmin.cuerpo?.codigo !== 'REQUIERE_CONTRASENA' && (await restriccion.limitesDe(ids.admin, 'administrador')) === null, 'un administrador no se limita: no se le pide contraseña');
    await restriccion.candado.levantar(ids.admin);
    console.log('OK 3c: un administrador no queda bajo vigilancia.');

    // ════════ 4) Lo que ve y decide el administrador ════════
    const lista = await http('/admin/bloqueos', { token: tokenAdmin });
    afirmar(lista.status === 200, `el administrador debe poder listar (llegó ${lista.status})`);
    const vigilada = lista.cuerpo.restringidas.find((r) => r.usuario.id === ids.comprador);
    afirmar(vigilada && vigilada.casos[0].tipo === 'restriccion' && vigilada.casos[0].motivo.length > 20 && vigilada.usuario.ficha?.correo === 'escalonada.comprador@example.com', 'la cuenta aparece "bajo vigilancia" con su caso, motivo y ficha');
    afirmar(!lista.cuerpo.activas.some((a) => a.usuario.id === ids.comprador), 'y NO entre las suspendidas');
    afirmar(vigilada.restanteSegundos > (cfg.duracionMs - 5 * 60000) / 1000, 'con el tiempo restante que cuenta Redis');
    const c = lista.cuerpo.configuracion;
    afirmar(c.restriccion.habilitado && c.restriccion.montoMaximo === 100 && c.restriccion.pedidosPorHora === 1 && c.restriccion.horas === cfg.horas && lista.cuerpo.resumen.restringidas >= 1, 'junto con la configuración de los límites y el resumen');
    afirmar(typeof c.pedidosPorHora === 'number', 'y el tope general de pedidos por hora');
    const mapa = (await http('/admin/fraude', { token: tokenAdmin })).cuerpo;
    afirmar(ids.comprador in mapa.restringidas && !(ids.comprador in mapa.bloqueadas), 'el panel de fraude marca a la cuenta como restringida (no suspendida)');
    afirmar((await http('/admin/bloqueos', { token: tokenComprador })).status === 403, 'un comprador no entra a esta sección');
    console.log('OK 4a: GET /admin/bloqueos lista la cuenta bajo vigilancia (separada de las suspendidas) con los límites vigentes; el panel de fraude la marca.');

    const quitada = await http(`/admin/bloqueos/${ids.comprador}/quitar-restriccion`, { metodo: 'POST', token: tokenAdmin, body: { nota: 'Verificación: falso positivo' } });
    afirmar(quitada.status === 200 && quitada.cuerpo.casosCerrados === 1 && quitada.cuerpo.restriccionLevantada === true, `quitar los límites debe cerrar el caso y borrar el candado (llegó ${quitada.status})`);
    afirmar((await redis.exists(`restriccion:${ids.comprador}`)) === 0, 'la clave de Redis ya no existe');
    afirmar((await http(`/admin/bloqueos/${ids.comprador}/quitar-restriccion`, { metodo: 'POST', token: tokenAdmin, body: {} })).status === 404, 'quitar de nuevo, sin nada que quitar → 404');
    await redis.del(`limite:pedidos:${ids.comprador}`);
    const libre = await pedido(comprador, tokenComprador);
    afirmar(libre.status === 201, `sin límites, el pedido pasa sin contraseña y sin tope de monto (llegó ${libre.status}: ${libre.cuerpo?.error})`);
    const historial = (await http('/admin/bloqueos', { token: tokenAdmin })).cuerpo.historial.find((h) => h.usuario.id === ids.comprador && h.tipo === 'restriccion');
    afirmar(historial?.estado === 'liberado' && historial.revisado?.nota === 'Verificación: falso positivo', 'el historial guarda el caso con su tipo, quién lo cerró y la nota');
    console.log('OK 4b: el administrador quita los límites: el caso se cierra, Redis suelta la clave y la cuenta compra sin restricciones.');

    // ════════ 5) El barrido, escalonado ════════
    process.env.RESTRICCION_MONTO_MAXIMO = '500';
    process.env.RESTRICCION_PEDIDOS_HORA = '2';
    const fraude = await consultarFraude();
    const grupo = fraude.cuentasRelacionadas.find((g) => g.miembros.some((m) => m.id === ids.a) && g.miembros.some((m) => m.id === ids.b));
    afirmar(grupo, 'el par con el mismo nombre debe aparecer como cuentas de una misma persona');
    afirmar(grupo.nivelConfianza === 'posible' && grupo.corroboradores.length === 0, `mismo nombre y fechas de nacimiento distintas es solo «posible», sin corroboradores (llegó ${grupo.nivelConfianza})`);
    console.log('OK 5a: el grafo marca a los homónimos con confianza «posible».');

    const resumen = await bloqueo.evaluar();
    afirmar(Array.isArray(resumen.advertencias), 'el barrido debe devolver su resumen');
    for (const id of [ids.a, ids.b]) {
      const casos = await prisma.bloqueo_cuenta.findMany({ where: { id_usuario: id, estado: 'activo' } });
      afirmar(casos.length === 1 && casos[0].tipo === 'restriccion' && casos[0].senal === 'cuentas_relacionadas', `la cuenta #${id} debe tener UN caso activo de tipo restricción, no de suspensión (tiene ${casos.map((x) => x.tipo)})`);
      afirmar((await redis.exists(`restriccion:${id}`)) === 1 && (await redis.exists(`bloqueo:${id}`)) === 0, `con restriccion:{id} en Redis y sin bloqueo:{id}`);
    }
    afirmar((await http('/auth/me', { token: tokenDe(gemeloA, 'comprador') })).status === 200, 'ninguna queda suspendida: siguen entrando');
    const sinContrasena = await pedido(gemeloA, tokenDe(gemeloA, 'comprador'));
    afirmar(sinContrasena.status === 403 && sinContrasena.cuerpo.codigo === 'REQUIERE_CONTRASENA', 'pero para comprar necesitan su contraseña');
    console.log('OK 5b: un hallazgo «posible» deja a las dos cuentas bajo vigilancia (restriccion:{id}), no suspendidas.');

    await bloqueo.evaluar();
    afirmar((await prisma.bloqueo_cuenta.count({ where: { id_usuario: { in: [ids.a, ids.b] } } })) === 2, 'un segundo barrido no repite los casos (único por cuenta, hallazgo y tipo)');

    // El administrador le quita los límites a A: ese hallazgo no vuelve a limitarla.
    await http(`/admin/bloqueos/${ids.a}/quitar-restriccion`, { metodo: 'POST', token: tokenAdmin, body: { nota: 'Verificación: A no es sospechosa' } });
    await bloqueo.evaluar();
    afirmar((await redis.exists(`restriccion:${ids.a}`)) === 0 && (await redis.exists(`restriccion:${ids.b}`)) === 1, 'tras quitarle los límites a A, otro barrido no se los vuelve a poner (B sigue bajo vigilancia)');
    console.log('OK 5c: un segundo barrido no repite los casos, y lo que un administrador quitó no vuelve por el mismo hallazgo.');

    // Escalada: los mismos homónimos declaran la misma fecha de nacimiento → el hallazgo sube a «alta».
    await prisma.usuarios.update({ where: { id_usuario: ids.b }, data: { fecha_nacimiento: new Date('1990-04-04') } });
    const subio = (await consultarFraude()).cuentasRelacionadas.find((g) => g.miembros.some((m) => m.id === ids.a) && g.miembros.some((m) => m.id === ids.b));
    afirmar(subio.nivelConfianza === 'alta' && subio.corroboradores.some((x) => x.tipo === 'fechaNacimiento'), 'la misma fecha de nacimiento corrobora el hallazgo y lo sube a «alta»');
    await bloqueo.evaluar();
    for (const id of [ids.a, ids.b]) {
      afirmar((await redis.exists(`bloqueo:${id}`)) === 1, `al subir a «alta», la cuenta #${id} se SUSPENDE (A, aunque se le hubieran quitado los límites: ese caso era de otro tipo)`);
    }
    const suspendidaB = await http('/auth/me', { token: tokenDe(gemeloB, 'comprador') });
    afirmar(suspendidaB.status === 403 && suspendidaB.cuerpo.codigo === 'CUENTA_SUSPENDIDA', 'B ya no puede usar su token (403 CUENTA_SUSPENDIDA)');
    afirmar((await redis.exists(`restriccion:${ids.b}`)) === 1, 'y conserva su vigilancia: la escalada suma una suspensión, no la reemplaza');
    const tipos = (await prisma.bloqueo_cuenta.findMany({ where: { id_usuario: ids.b, estado: 'activo' } })).map((x) => x.tipo).sort();
    afirmar(tipos.join() === 'restriccion,suspension', `B tiene dos casos activos, uno de cada tipo (tiene ${tipos})`);
    console.log('OK 5d: un «posible» que sube a «alta» suspende a la cuenta y su vigilancia sigue en pie.');

    // Liberar la suspensión no libera la vigilancia: B vuelve, pero sigue con límites.
    await http(`/admin/bloqueos/${ids.b}/liberar`, { metodo: 'POST', token: tokenAdmin, body: { nota: 'Verificación: se levanta la suspensión' } });
    afirmar((await http('/auth/me', { token: tokenDe(gemeloB, 'comprador') })).status === 200, 'al liberar la suspensión, B vuelve a entrar');
    const aunLimitada = await pedido(gemeloB, tokenDe(gemeloB, 'comprador'));
    afirmar(aunLimitada.status === 403 && aunLimitada.cuerpo.codigo === 'REQUIERE_CONTRASENA', 'pero sigue bajo vigilancia: para comprar, su contraseña');
    console.log('OK 5e: liberar la suspensión no quita la vigilancia: son dos decisiones separadas.');

    console.log('Todas las verificaciones de la respuesta escalonada pasaron.');
  } finally {
    // Pase lo que pase: las cuentas de la verificación quedan libres, las fechas como se
    // sembraron, la oferta pausada y el producto inactivo (no se queda en la tienda).
    await prisma.bloqueo_cuenta.updateMany({ where: { id_usuario: { in: todos }, estado: 'activo' }, data: { estado: 'liberado', revisado_por: ids.admin, revisado_en: new Date(), nota_revision: 'Limpieza de la verificación' } });
    for (const id of todos) {
      await suspension.levantar(id);
      await restriccion.candado.levantar(id);
      await redis.del(`limite:pedidos:${id}`, `reauth:intentos:${id}`);
    }
    await prisma.usuarios.update({ where: { id_usuario: ids.b }, data: { fecha_nacimiento: new Date('1991-05-05') } }).catch(() => {});
    await ofertaFlash.actualizar({ id_usuario: ids.vendedor, rol: 'vendedor' }, producto.id, { activo: false }).catch(() => {});
    await redis.del(`oferta:${producto.id}:stock`);
    await Producto.updateOne({ producto_id: producto.id }, { $set: { estado: 'inactivo' } });
    await ofertaDatos.invalidar(producto.id);
    await indexar().catch(() => {});
    servidor.closeAllConnections();
    await new Promise((resolve) => servidor.close(resolve));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await bloqueo.detener();
    await prisma.$disconnect();
    await mongoose.disconnect();
    await neo4j.cerrar();
    await elastic.cerrar();
    redisConfig.cerrar();
  });
