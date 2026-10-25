require('dotenv').config();
const prisma = require('../src/config/prisma');
const { crearCuenta } = require('./lib/datosPrueba');

// Evidencia de la pantalla de permisos (IA/ADR-007 §9) contra el backend REAL, con MySQL, MongoDB y Redis de verdad: hay
// que tenerlo corriendo (`npm run dev`; por omisión en http://localhost:3000/api, o API_URL). Prueba por HTTP, con las
// cuentas de siempre y dos de prueba que crea (`permisos.admin@…` y `permisos.auditor@…`, contraseña Password123!):
//   1. quién ve la matriz (un vendedor y quien no inició sesión, no);
//   2. conceder una ruta a un rol, que rija al instante, y volver a quitarla (restaurar);
//   3. lo que NO se puede cambiar: administrar permisos, lo que depende del dueño, la columna del administrador,
//      el propio rol;
//   4. un rol nuevo que empieza sin nada, recibe UNA ruta y solo esa, y la pierde al instante al cambiarle el rol a la
//      cuenta (se decide con el rol de hoy, no con el del token de 2 h);
//   5. el simulador, que dice lo mismo que la API;
//   6. la auditoría: lo hecho queda registrado (también lo denegado) y se descarga en CSV.
// Termina dejando todo como estaba (reglas restauradas, rol borrado, cuenta de vuelta a comprador) y sale con código 1
// si algo no coincide.
const BASE = process.env.API_URL || 'http://localhost:3000/api';
const CLAVE = 'Password123!';
const VENTAS = 'GET /api/admin/ventas';
const FRAUDE = 'GET /api/admin/fraude';
const ROL = 'auditor-prueba';

async function api(metodo, ruta, token, cuerpo) {
  const respuesta = await fetch(BASE + ruta, {
    method: metodo,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(cuerpo !== undefined && { 'Content-Type': 'application/json' }) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  // Por bytes: fetch().text() decodifica en UTF-8 y se come la marca de orden de bytes del CSV, que acá se quiere ver.
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  const texto = bytes.toString('utf8');
  let json = texto;
  try { json = JSON.parse(texto.replace(/^﻿/, '')); } catch { /* un CSV */ }
  return { estado: respuesta.status, cuerpo: json, encabezados: respuesta.headers, bytes };
}

async function entrar(correo) {
  const r = await api('POST', '/auth/login', null, { correo, contrasena: CLAVE });
  if (r.estado !== 200) throw new Error(`No se pudo iniciar sesión como ${correo}: ${r.estado} ${JSON.stringify(r.cuerpo)}`);
  return r.cuerpo.token;
}

let fallas = 0;
function comprobar(condicion, texto, detalle = '') {
  console.log(`${condicion ? 'OK   ' : 'FALLA'} — ${texto}${detalle ? ` · ${detalle}` : ''}`);
  if (!condicion) fallas += 1;
}

async function main() {
  try {
    await fetch(BASE.replace(/\/api$/, '/api/health'), { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`El backend no responde en ${BASE}: levantalo con npm run dev (o indicá API_URL).`);
  }
  const administrador = await crearCuenta('permisos.admin@example.com', 'Admin', { apellidos: 'Permisos', rol: 'administrador' });
  const cuenta = await crearCuenta('permisos.auditor@example.com', 'Rosa', { apellidos: 'Auditora' });
  await prisma.usuarios.update({ where: { id_usuario: cuenta.id_usuario }, data: { rol_id: (await prisma.rol_usuario.findFirst({ where: { tipo_rol: 'comprador' } })).id } });
  const admin = await entrar('permisos.admin@example.com');
  const luis = await entrar('luis.ramirez@example.com');
  const antes = (await api('GET', '/admin/auditoria?tipo=cambios&tamano=1', admin)).cuerpo.total;

  try {
    console.log('1. Quién ve la matriz');
    const matriz = await api('GET', '/admin/permisos', admin);
    comprobar(matriz.estado === 200 && matriz.cuerpo.rutas.length >= 20, 'el administrador ve la matriz', `${matriz.cuerpo.roles?.map((r) => r.nombre).join(', ')} · ${matriz.cuerpo.rutas?.length} acciones`);
    comprobar(matriz.encabezados.get('cache-control') === 'no-store', 'la matriz no se guarda en ninguna caché');
    const deVendedor = await api('GET', '/admin/permisos', luis);
    comprobar(deVendedor.estado === 403 && deVendedor.cuerpo.codigo === 'ACL_DENEGADO', 'un vendedor NO la ve: 403 ACL_DENEGADO');
    comprobar((await api('GET', '/admin/permisos', null)).estado === 401, 'sin sesión: 401');
    const yoLuis = await api('GET', '/auth/me', luis);
    comprobar(yoLuis.cuerpo.permisos.includes('POST /api/categorias') && !yoLuis.cuerpo.permisos.includes(VENTAS), '/auth/me del vendedor lista lo que puede usar: categorías sí, ventas no');

    console.log('\n2. Conceder una ruta a un rol, que rija al instante, y restaurar');
    comprobar((await api('GET', '/admin/ventas', luis)).estado === 403, 'el vendedor NO puede ver ventas');
    const concede = await api('PUT', '/admin/permisos', admin, { cambios: [{ clave: VENTAS, rol: 'vendedor', permitido: true }] });
    comprobar(concede.estado === 200 && concede.cuerpo.aplicados.length === 1 && concede.cuerpo.auditado === true, 'el administrador se la concede al rol vendedor', JSON.stringify(concede.cuerpo.aplicados?.[0]));
    comprobar((await api('GET', '/admin/ventas', luis)).estado !== 403, 'el vendedor ya puede llamarla, sin volver a iniciar sesión');
    const restaura = await api('POST', '/admin/permisos/restaurar', admin, { clave: VENTAS });
    comprobar(restaura.estado === 200 && restaura.cuerpo.restauradas === 1, 'se restaura a lo que declara el código');
    comprobar((await api('GET', '/admin/ventas', luis)).estado === 403, 'el vendedor vuelve a NO poder');

    console.log('\n3. Lo que no se puede cambiar');
    const intento = async (cambio) => api('PUT', '/admin/permisos', admin, { cambios: [cambio] });
    const fijaPermisos = await intento({ clave: 'GET /api/admin/permisos', rol: 'vendedor', permitido: true });
    comprobar(fijaPermisos.estado === 400 && /no se puede cambiar/.test(fijaPermisos.cuerpo.error), 'administrar permisos no se concede a otro rol');
    const fijaDueno = await intento({ clave: 'GET /api/productos/:id/historial', rol: 'comprador', permitido: true });
    comprobar(fijaDueno.estado === 400 && /dueño/.test(fijaDueno.cuerpo.error), 'una ruta que comprueba al dueño del producto es fija');
    const alAdmin = await intento({ clave: VENTAS, rol: 'administrador', permitido: false });
    comprobar(alAdmin.estado === 400 && /conserva todas/.test(alAdmin.cuerpo.error), 'al administrador no se le quita nada');
    const lote = await api('PUT', '/admin/permisos', admin, { cambios: [{ clave: VENTAS, rol: 'vendedor', permitido: true }, { clave: 'GET /no-existe', rol: 'vendedor', permitido: true }] });
    comprobar(lote.estado === 400 && (await api('GET', '/admin/ventas', luis)).estado === 403, 'un lote con un cambio inválido no aplica NINGUNO (todo o nada)');
    const propio = await api('PATCH', `/admin/usuarios/${administrador.id_usuario}/rol`, admin, { rol: 'comprador' });
    comprobar(propio.estado === 400 && /propio rol/.test(propio.cuerpo.error), 'nadie cambia su propio rol');

    console.log('\n4. Un rol nuevo: empieza sin nada, recibe UNA ruta y solo esa');
    const creado = await api('POST', '/admin/roles', admin, { nombre: ROL });
    comprobar([201, 409].includes(creado.estado), `se crea el rol ${ROL}`, `HTTP ${creado.estado}`);
    const asigna = await api('PATCH', `/admin/usuarios/${cuenta.id_usuario}/rol`, admin, { rol: ROL });
    comprobar(asigna.estado === 200, 'se le asigna a la cuenta de prueba', JSON.stringify(asigna.cuerpo));
    const token = await entrar('permisos.auditor@example.com'); // el token trae «auditor-prueba»
    comprobar((await api('GET', '/admin/fraude', token)).estado === 403, 'sin permisos concedidos no ve fraude');
    comprobar((await api('PUT', '/admin/permisos', admin, { cambios: [{ clave: FRAUDE, rol: ROL, permitido: true }] })).estado === 200, 'se le concede ver fraude');
    comprobar((await api('GET', '/admin/fraude', token)).estado === 200, 'ya lo ve (en segundos, con el mismo token)');
    comprobar((await api('GET', '/admin/bloqueos', token)).estado === 403, 'pero no las cuentas suspendidas: solo lo que se le concedió');
    const yo = await api('GET', '/auth/me', token);
    comprobar(JSON.stringify(yo.cuerpo.permisos) === JSON.stringify([FRAUDE]), '/auth/me del auditor lista solo eso', JSON.stringify(yo.cuerpo.permisos));

    console.log('\n5. El simulador dice lo mismo que la API');
    const sim = await api('GET', `/admin/permisos/simular?clave=${encodeURIComponent(FRAUDE)}&rol=${ROL}`, admin);
    comprobar(sim.cuerpo.permitido === true && sim.cuerpo.origen === 'regla', 'simulado: el auditor SÍ puede ver fraude, por una regla', sim.cuerpo.motivo?.slice(0, 90));
    const simNo = await api('GET', `/admin/permisos/simular?clave=${encodeURIComponent(VENTAS)}&usuarioId=${cuenta.id_usuario}`, admin);
    comprobar(simNo.cuerpo.permitido === false && simNo.cuerpo.rol === ROL, 'simulado por cuenta: ventas NO', simNo.cuerpo.motivo?.slice(0, 90));

    console.log('\n6. Cambiar el rol de la cuenta corta el acceso al instante');
    const borrarConCuentas = await api('DELETE', `/admin/roles/${(await api('GET', '/admin/permisos', admin)).cuerpo.roles.find((r) => r.nombre === ROL).id}`, admin);
    comprobar(borrarConCuentas.estado === 409, 'no se borra un rol que todavía tiene cuentas', borrarConCuentas.cuerpo.error);
    comprobar((await api('PATCH', `/admin/usuarios/${cuenta.id_usuario}/rol`, admin, { rol: 'comprador' })).estado === 200, 'la cuenta vuelve a comprador');
    comprobar((await api('GET', '/admin/fraude', token)).estado === 403, 'con el MISMO token, ya no ve fraude (se decide con el rol de hoy)');

    console.log('\n7. Auditoría');
    const cambios = await api('GET', '/admin/auditoria?tipo=cambios&tamano=30', admin);
    const tipos = new Set(cambios.cuerpo.registros.map((r) => r.tipo));
    comprobar(['regla', 'restaurar', 'rol_creado', 'rol_cuenta'].every((t) => tipos.has(t)) || cambios.cuerpo.total > antes, 'los cambios quedaron registrados', `${cambios.cuerpo.total - antes} nuevos · tipos: ${[...tipos].join(', ')}`);
    const reciente = cambios.cuerpo.registros[0];
    comprobar(reciente.actor.correo === 'permisos.admin@example.com' && reciente.actor.rol === 'administrador', 'dicen quién lo hizo (nombre y correo se resuelven al leer)', `${reciente.actor.nombre} · ${reciente.actor.correo}`);
    const desde = new Date(Date.now() - 3 * 60000);
    const denegaciones = await api('GET', '/admin/auditoria?tipo=denegacion&tamano=50', admin);
    comprobar(denegaciones.cuerpo.registros.some((r) => r.objetivo.id === VENTAS && new Date(r.fecha) > desde), 'lo denegado también: el 403 de ventas quedó anotado', `${denegaciones.cuerpo.total} denegaciones en total`);
    const csv = await api('GET', '/admin/auditoria/exportar?tipo=cambios', admin);
    comprobar(csv.estado === 200 && csv.bytes[0] === 0xef && /text\/csv/.test(csv.encabezados.get('content-type')) && /attachment/.test(csv.encabezados.get('content-disposition')), 'el CSV se descarga con su marca UTF-8', `${csv.bytes.length} bytes`);
    comprobar((await api('GET', '/admin/auditoria?desde=ayer', admin)).estado === 400, 'un filtro mal escrito es un 400');
  } finally {
    // Todo como estaba: sin reglas de este ensayo, el rol borrado y la cuenta de vuelta a comprador.
    const roles = (await api('GET', '/admin/permisos', admin)).cuerpo.roles ?? [];
    await prisma.usuarios.update({ where: { id_usuario: cuenta.id_usuario }, data: { rol_id: roles.find((r) => r.nombre === 'comprador').id } });
    const sobrante = roles.find((r) => r.nombre === ROL);
    if (sobrante) await api('DELETE', `/admin/roles/${sobrante.id}`, admin);
    await api('POST', '/admin/permisos/restaurar', admin, { clave: VENTAS });
    console.log('\n(limpieza: reglas restauradas, rol borrado, cuenta de vuelta a comprador)');
  }

  console.log(fallas === 0 ? 'Todas las verificaciones de permisos pasaron.' : `Hay ${fallas} verificación(es) que fallaron.`);
  process.exitCode = fallas === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
