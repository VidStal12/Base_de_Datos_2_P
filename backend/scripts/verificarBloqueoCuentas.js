require('dotenv').config();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const prisma = require('../src/config/prisma');
const neo4j = require('../src/config/neo4j');
const redisConfig = require('../src/config/redis');
// consultarFraude/checkout leen el catálogo y Mongoose necesita Categoria registrado.
require('../src/models/mongo/Categoria');
const app = require('../src/app');
const { checkout } = require('../src/services/checkoutService');
const { consultarFraude } = require('../src/services/fraudeService');
const bloqueo = require('../src/services/bloqueoService');
const suspension = require('../src/services/suspensionService');
const { afirmar, prepararCuenta, asegurarProducto, conProductoActivo } = require('./lib/datosPrueba');

// Evidencia, contra un Redis, un MySQL y un Neo4j de verdad, de la suspensión
// temporal de cuentas por fraude de confianza alta (ver
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §20 y bloqueoService.js): el hallazgo alto abre
// un caso en MySQL y un bloqueo en Redis con TTL; el bloqueo se hace cumplir en el
// login y en cada petición; un administrador lo revisa (extender / liberar); lo
// liberado o vencido no vuelve a suspender por el mismo hallazgo; y Redis puede
// perder el bloqueo sin que MySQL pierda el caso.
//
// Siembra su propio patrón sintético — dos cuentas que usan el mismo buzón de
// correo (alias "+"), cada una comprando por su lado: "cuentas de una misma persona"
// por buzón, alta por sí sola — con checkout() real. Es idempotente: antes de
// empezar borra los casos de ESAS cuentas, y al terminar las deja libres.
//
// Ojo: evaluar() es el mismo barrido que corre el backend cada minuto, así que
// también abre los casos de cualquier OTRA cuenta con un hallazgo alto en esta base
// (en desarrollo, las cuentas `fraude.*` que siembra verificar:fraude) y las deja
// suspendidas 24 h — es lo que haría el backend de todos modos; se revisan y liberan
// en /admin/bloqueos.
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HORA = 3600000;

async function main() {
  const config = bloqueo.configuracion();
  const redis = redisConfig.conectar('admin');

  // --- 0) Datos de prueba: un administrador, un vendedor con un producto y el par por buzón ---
  const admin = await prepararCuenta('bloqueo.admin@example.com', 'Bloqueo Admin', 'tok_bloqueo_admin', { rol: 'administrador' });
  const vendedor = await prepararCuenta('bloqueo.vendedor@example.com', 'Bloqueo Vendedor', 'tok_bloqueo_vendedor', { rol: 'vendedor' });
  const producto = await asegurarProducto(vendedor.usuario, '[PRUEBA bloqueo] Producto del vendedor de la verificación', 30, { cantidad: 100 });
  const cuentaA = await prepararCuenta('bloqueo.anillo@example.com', 'Bloqueo AnilloA', 'tok_bloqueo_anillo_a');
  const cuentaB = await prepararCuenta('bloqueo.anillo+segunda@example.com', 'Bloqueo AnilloB', 'tok_bloqueo_anillo_b');
  const idA = cuentaA.usuario.id_usuario;
  const idB = cuentaB.usuario.id_usuario;
  const ordenes = (id) => prisma.compra.count({ where: { id_usuario: id, pagos: { some: { estado: 'aprobado' } } } });
  for (const cuenta of [cuentaA, cuentaB]) {
    if ((await ordenes(cuenta.usuario.id_usuario)) === 0) {
      await conProductoActivo(producto, () =>
        checkout({
          usuarioId: cuenta.usuario.id_usuario,
          direccionId: cuenta.direccion.id,
          metodoPagoId: cuenta.metodoPago.id,
          items: [{ productoId: producto.id, cantidad: 1 }],
        })
      );
    }
  }
  // Parten de cero: sin casos ni bloqueo de una corrida anterior.
  await prisma.bloqueo_cuenta.deleteMany({ where: { id_usuario: { in: [idA, idB] } } });
  await suspension.levantar(idA);
  await suspension.levantar(idB);
  await suspension.levantar(admin.usuario.id_usuario);

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
    return { status: res.status, cuerpo: await res.json().catch(() => null) };
  };
  const tokenDe = (cuenta, rol) => jwt.sign({ id_usuario: cuenta.usuario.id_usuario, rol_id: cuenta.usuario.rol_id, rol }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const tokenAdmin = tokenDe(admin, 'administrador');

  try {
    // --- 1) La detección ve el hallazgo alto (Neo4j) ---
    const fraude = await consultarFraude();
    const grupo = fraude.cuentasRelacionadas.find((g) => g.miembros.some((m) => m.id === idA) && g.miembros.some((m) => m.id === idB));
    afirmar(grupo, 'el par que comparte buzón debe aparecer como cuentas de una misma persona');
    afirmar(grupo.nivelConfianza === 'alta', `compartir buzón es "alta" por sí solo (llegó: ${grupo.nivelConfianza})`);
    console.log(`OK 1: el grafo marca a las cuentas #${idA} y #${idB} como una misma persona, confianza alta.`);

    // --- 2) El barrido las suspende: caso en MySQL + bloqueo en Redis con TTL ---
    const resumen = await bloqueo.evaluar();
    afirmar(Array.isArray(resumen.advertencias), 'el barrido debe devolver su resumen');
    for (const id of [idA, idB]) {
      const casos = await prisma.bloqueo_cuenta.findMany({ where: { id_usuario: id } });
      afirmar(casos.length === 1 && casos[0].estado === 'activo' && casos[0].senal === 'cuentas_relacionadas', `la cuenta #${id} debe tener un caso activo de cuentas de una misma persona (tiene ${casos.length})`);
      afirmar(casos[0].evidencia?.involucradas?.length === 2, 'el caso guarda la evidencia con la que se abrió');
      const ms = await redis.pttl(`bloqueo:${id}`);
      afirmar(ms > config.duracionMs - 5 * 60000 && ms <= config.duracionMs, `el TTL de Redis debe ser la duración configurada (${config.horas} h); es ${Math.round(ms / 1000)} s`);
    }
    console.log(`OK 2: el barrido suspendió a las dos cuentas — un caso en MySQL y bloqueo:{id} en Redis con TTL de ${config.horas} h.`);

    // --- 3) El mismo hallazgo no suspende dos veces ---
    const otra = await bloqueo.evaluar();
    afirmar(!otra.cuentas.some((c) => [idA, idB].includes(c.usuarioId)), 'un segundo barrido no debe volver a suspender a las mismas cuentas por el mismo hallazgo');
    afirmar((await prisma.bloqueo_cuenta.count({ where: { id_usuario: { in: [idA, idB] } } })) === 2, 'y no abre casos repetidos (único por cuenta y hallazgo)');
    console.log('OK 3: un segundo barrido no repite el caso (único por cuenta y hallazgo).');

    // --- 4) Se hace cumplir: login y cada petición ---
    const me = await http('/auth/me', { token: tokenDe(cuentaA, 'comprador') });
    afirmar(me.status === 403 && me.cuerpo.codigo === 'CUENTA_SUSPENDIDA', `una cuenta suspendida no puede usar su token (llegó ${me.status})`);
    afirmar(/suspendida temporalmente/.test(me.cuerpo.error) && Math.abs(new Date(me.cuerpo.hasta) - (Date.now() + config.duracionMs)) < 5 * 60000, 'y el mensaje y `hasta` dicen cuándo se levanta');
    afirmar(!/cuentas_relacionadas|buzón|misma persona/i.test(me.cuerpo.error), 'el mensaje no revela qué señal la disparó');
    const loginOk = await http('/auth/login', { metodo: 'POST', body: { correo: 'bloqueo.anillo@example.com', contrasena: 'Password123!' } });
    afirmar(loginOk.status === 403 && loginOk.cuerpo.codigo === 'CUENTA_SUSPENDIDA' && !loginOk.cuerpo.token, `con la contraseña correcta, el login de una cuenta suspendida da 403 sin token (llegó ${loginOk.status})`);
    const loginMal = await http('/auth/login', { metodo: 'POST', body: { correo: 'bloqueo.anillo@example.com', contrasena: 'incorrecta' } });
    afirmar(loginMal.status === 401 && loginMal.cuerpo.error === 'Credenciales inválidas', 'con una contraseña incorrecta no se revela que la cuenta está suspendida');
    const catalogo = await http('/productos', { token: tokenDe(cuentaA, 'comprador') });
    afirmar(catalogo.status === 200, 'el catálogo público sigue abierto: una cuenta suspendida se trata como visitante');
    const sinPermiso = await http('/admin/bloqueos', { token: tokenDe(vendedor, 'vendedor') });
    afirmar(sinPermiso.status === 403, 'un vendedor no entra a la sección de cuentas bloqueadas');
    afirmar((await http('/admin/bloqueos')).status === 401, 'sin sesión tampoco');
    console.log('OK 4: login y token rechazados con 403 CUENTA_SUSPENDIDA (sin revelar la señal); el catálogo público sigue abierto; la sección es solo de administrador.');

    // --- 5) Lo que ve el administrador ---
    const lista = await http('/admin/bloqueos', { token: tokenAdmin });
    afirmar(lista.status === 200, `el administrador debe poder listar (llegó ${lista.status})`);
    const activaA = lista.cuerpo.activas.find((a) => a.usuario.id === idA);
    afirmar(activaA && activaA.revisado === null && activaA.casos.length === 1, 'la cuenta aparece pendiente de revisión, con su caso');
    afirmar(activaA.casos[0].motivo.length > 20 && activaA.usuario.ficha?.correo === 'bloqueo.anillo@example.com', 'con el motivo en prosa y la ficha de la cuenta');
    afirmar(activaA.restanteSegundos > (config.duracionMs - 5 * 60000) / 1000, 'y el tiempo restante que cuenta Redis');
    afirmar(lista.cuerpo.configuracion.horas === config.horas && lista.cuerpo.resumen.activas >= 2, 'junto con la configuración y el resumen');
    console.log('OK 5: GET /admin/bloqueos devuelve el caso pendiente de revisión con motivo, ficha y tiempo restante.');

    // --- 6) Extender: mantiene la suspensión y suma tiempo (Redis y MySQL) ---
    const antesMs = await redis.pttl(`bloqueo:${idB}`);
    const extendida = await http(`/admin/bloqueos/${idB}/extender`, { metodo: 'POST', token: tokenAdmin, body: { horas: 1, nota: 'Verificación: se mantiene' } });
    afirmar(extendida.status === 200, `extender debe responder 200 (llegó ${extendida.status})`);
    const despuesMs = await redis.pttl(`bloqueo:${idB}`);
    afirmar(despuesMs - antesMs > HORA - 60000 && despuesMs - antesMs < HORA + 60000, `el TTL de Redis debe subir una hora (subió ${Math.round((despuesMs - antesMs) / 60000)} min)`);
    const casoB = await prisma.bloqueo_cuenta.findFirst({ where: { id_usuario: idB } });
    afirmar(casoB.estado === 'activo' && casoB.revisado_por === admin.usuario.id_usuario && casoB.nota_revision === 'Verificación: se mantiene', 'MySQL guarda quién lo revisó y la nota');
    const revisada = (await http('/admin/bloqueos', { token: tokenAdmin })).cuerpo.activas.find((a) => a.usuario.id === idB);
    afirmar(revisada.revisado?.nota === 'Verificación: se mantiene', 'y la lista lo muestra como revisado');
    afirmar((await http(`/admin/bloqueos/${idB}/extender`, { metodo: 'POST', token: tokenAdmin, body: { horas: 0 } })).status === 400, 'horas inválidas → 400');
    afirmar((await http('/admin/bloqueos/abc/liberar', { metodo: 'POST', token: tokenAdmin, body: {} })).status === 400, 'un id que no es número → 400');
    console.log('OK 6: extender suma una hora al TTL de Redis y al caso, y anota quién lo revisó.');

    // --- 7) Liberar: el visto bueno de un administrador ---
    const liberada = await http(`/admin/bloqueos/${idA}/liberar`, { metodo: 'POST', token: tokenAdmin, body: { nota: 'Verificación: falso positivo' } });
    afirmar(liberada.status === 200 && liberada.cuerpo.casosCerrados === 1, `liberar debe cerrar el caso (llegó ${liberada.status})`);
    afirmar((await redis.exists(`bloqueo:${idA}`)) === 0, 'y borrar el bloqueo de Redis');
    afirmar((await http('/auth/me', { token: tokenDe(cuentaA, 'comprador') })).status === 200, 'la cuenta vuelve a poder usar su token');
    const loginLiberada = await http('/auth/login', { metodo: 'POST', body: { correo: 'bloqueo.anillo@example.com', contrasena: 'Password123!' } });
    afirmar(loginLiberada.status === 200 && loginLiberada.cuerpo.token, 'y a iniciar sesión');
    afirmar((await http(`/admin/bloqueos/${idA}/liberar`, { metodo: 'POST', token: tokenAdmin, body: {} })).status === 404, 'liberar de nuevo, sin nada que liberar → 404');
    console.log('OK 7: liberar cierra el caso, borra el bloqueo y la cuenta entra de nuevo.');

    // --- 8) Lo liberado no vuelve a suspender por el mismo hallazgo ---
    await bloqueo.evaluar();
    afirmar((await redis.exists(`bloqueo:${idA}`)) === 0, 'el grafo sigue marcando a la cuenta, pero ese hallazgo ya fue revisado: no se vuelve a suspender');
    afirmar((await prisma.bloqueo_cuenta.count({ where: { id_usuario: idA } })) === 1, 'ni se abre otro caso');
    console.log('OK 8: tras liberar, otro barrido no vuelve a suspender a la cuenta por el mismo hallazgo.');

    // --- 9) Redis hace vencer el bloqueo solo, por TTL ---
    const corto = await bloqueo.abrirCaso({ usuarioId: idA, huella: `prueba:ttl:${Date.now()}`, senal: 'gasto_anomalo', motivo: 'Verificación del vencimiento por TTL', duracionMs: 2500 });
    afirmar(corto.creado, 'el caso de prueba debe abrirse');
    afirmar((await http('/auth/me', { token: tokenDe(cuentaA, 'comprador') })).status === 403, 'mientras corre el TTL, la cuenta está suspendida');
    await esperar(3200);
    afirmar((await redis.exists(`bloqueo:${idA}`)) === 0, 'Redis suelta la clave solo, sin que nadie la borre');
    afirmar((await http('/auth/me', { token: tokenDe(cuentaA, 'comprador') })).status === 200, 'y la cuenta vuelve a entrar al vencer el tiempo');
    const conciliado = await bloqueo.reconciliar();
    const casoCorto = await prisma.bloqueo_cuenta.findFirst({ where: { id_usuario: idA, huella: { startsWith: 'prueba:ttl:' } } });
    afirmar(conciliado.vencidos >= 1 && casoCorto.estado === 'expirado', 'MySQL marca el caso como expirado en la siguiente reconciliación');
    afirmar((await bloqueo.evaluar()) && (await redis.exists(`bloqueo:${idA}`)) === 0, 'y lo vencido tampoco vuelve a suspender');
    console.log('OK 9: el bloqueo venció solo por el TTL de Redis; el caso queda expirado y no se repite.');

    // --- 10) Redis puede perder el bloqueo sin que MySQL pierda el caso ---
    await redis.del(`bloqueo:${idB}`); // lo que pasaría con un reinicio de Redis
    afirmar((await http('/auth/me', { token: tokenDe(cuentaB, 'comprador') })).status === 200, 'sin la clave, Redis ya no la suspende');
    const reconstruido = await bloqueo.reconciliar();
    afirmar(reconstruido.reconstruidos >= 1, 'reconciliar reconstruye el bloqueo desde el caso activo');
    const ms = await redis.pttl(`bloqueo:${idB}`);
    afirmar(ms > config.duracionMs && ms < config.duracionMs + HORA + 5 * 60000, `con lo que falta del vencimiento (${Math.round(ms / 60000)} min), no con la duración completa`);
    afirmar((await http('/auth/me', { token: tokenDe(cuentaB, 'comprador') })).status === 403, 'y la cuenta vuelve a estar suspendida');
    // El script Lua real solo ALARGA: un bloqueo más corto no pisa al que ya corre.
    afirmar((await suspension.bloquear(idB, 1000)) === false && (await redis.pttl(`bloqueo:${idB}`)) > config.duracionMs, 'bloquearCuenta (Lua) no acorta una suspensión vigente');
    console.log('OK 10: se perdió el bloqueo de Redis y reconciliar() lo reconstruyó desde MySQL; el Lua real solo alarga.');

    // --- 11) Un administrador nunca queda bloqueado; un bloqueo sin caso se limpia ---
    await redis.set(`bloqueo:${admin.usuario.id_usuario}`, '{}', 'PX', 60000);
    afirmar((await http('/auth/me', { token: tokenAdmin })).status === 200, 'aunque exista una clave de bloqueo, un administrador sigue entrando');
    const limpiado = await bloqueo.reconciliar();
    afirmar(limpiado.huerfanos >= 1 && (await redis.exists(`bloqueo:${admin.usuario.id_usuario}`)) === 0, 'y un bloqueo en Redis sin ningún caso activo se quita');
    console.log('OK 11: un administrador no se bloquea; un bloqueo sin caso se limpia.');

    // --- 12) Cierre: se libera a B y el historial deja constancia ---
    await http(`/admin/bloqueos/${idB}/liberar`, { metodo: 'POST', token: tokenAdmin, body: { nota: 'Verificación: fin' } });
    const final = (await http('/admin/bloqueos', { token: tokenAdmin })).cuerpo;
    const historial = final.historial.filter((h) => [idA, idB].includes(h.usuario.id));
    afirmar(historial.some((h) => h.estado === 'liberado' && h.revisado?.por === 'Bloqueo Admin Prueba' && h.revisado.nota === 'Verificación: falso positivo'), 'el historial dice quién liberó, cuándo y por qué');
    afirmar(historial.some((h) => h.estado === 'expirado'), 'y distingue lo que venció solo');
    console.log('OK 12: el historial guarda la decisión de cada caso (quién, cuándo, nota) y lo vencido.');

    console.log('Todas las verificaciones del bloqueo de cuentas pasaron.');
  } finally {
    // Las dos cuentas de la verificación quedan libres, pase lo que pase.
    await prisma.bloqueo_cuenta.updateMany({ where: { id_usuario: { in: [idA, idB] }, estado: 'activo' }, data: { estado: 'liberado', revisado_por: admin.usuario.id_usuario, revisado_en: new Date(), nota_revision: 'Limpieza de la verificación' } });
    await suspension.levantar(idA);
    await suspension.levantar(idB);
    await suspension.levantar(admin.usuario.id_usuario);
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
    redisConfig.cerrar();
  });
