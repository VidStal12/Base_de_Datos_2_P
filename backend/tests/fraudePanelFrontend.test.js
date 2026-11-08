const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// frontend/src/utils/fraudeCasos.js son funciones puras: se cargan igual que productosVendedor.js (sin los `export`) y se
// prueban sin navegador. La ruta se puede cambiar con FRAUDE_CASOS_FUENTE para probar copias mutadas del módulo.
function cargar() {
  const ruta = process.env.FRAUDE_CASOS_FUENTE || path.join(__dirname, '../../frontend/src/utils/fraudeCasos.js');
  const fuente = fs.readFileSync(ruta, 'utf8').replace(/export /g, '');
  const contexto = { module: { exports: {} } };
  vm.runInNewContext(
    `${fuente}\nmodule.exports = { TIPOS, NIVELES, VINCULOS, FILTROS_VACIOS, LARGO_MAXIMO_USUARIO, aplanarCasos, normalizar, coincideUsuario, filtrar, conteos, relacionados, leerFiltros, aParametros, hayFiltros, sinFiltros, conUsuario, conNivel, conRelacion, conVinculo, conCaso, duracionTexto };`,
    contexto
  );
  return contexto.module.exports;
}
const f = cargar();
// Lo que devuelve el módulo cargado en el `vm` es de OTRO realm: deepEqual no lo iguala a un literal sin esto.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const claves = (casos) => Array.from(casos, (c) => c.clave);

// ---------- Datos con la forma de GET /api/admin/fraude ----------

const ficha = (id, nombre, correo) => ({ id, nombre, correo, rol: 'comprador' });
const cuenta = (id, nombre, correo) => ({ id, nombre, ficha: correo ? ficha(id, nombre, correo) : null });

const MARTA = cuenta(24, 'Marta Gómez', 'marta@correo.com');
const MARTA_DOS = cuenta(25, 'Marta Gomez', 'marta.dos@correo.com');
const LUIS = cuenta(2, 'Luis Ramírez', 'luis.ramirez@example.com');
const ANA = cuenta(30, 'Ana Pérez', 'ana@correo.com');
const ANA_DOS = cuenta(31, 'Ana Pérez', 'ana.otra@correo.com');
const MARIA = cuenta(12, 'María Núñez', 'maria@correo.com');

function datos(extra = {}) {
  return {
    autocompra: [
      { comprador: LUIS, vendedor: LUIS, mismaCuenta: true, mismoDispositivo: false, mismoBuzon: false, mismoPerfil: false, nivelConfianza: 'posible', pedidos: 5, total: 581.14, productos: ['Taza'], primera: '2026-10-01T10:00:00Z', ultima: '2026-10-09T10:00:00Z', corroboradores: [] },
      { comprador: MARTA, vendedor: MARTA_DOS, mismaCuenta: false, mismoDispositivo: true, mismoBuzon: false, mismoPerfil: false, dispositivosCompartidos: 1, nivelConfianza: 'posible', pedidos: 1, total: 150, productos: ['Lámpara'], primera: '2026-11-01T10:00:00Z', ultima: '2026-11-01T10:00:00Z', corroboradores: [] },
      { comprador: ANA, vendedor: ANA_DOS, mismaCuenta: false, mismoDispositivo: true, mismoBuzon: true, mismoPerfil: true, dispositivosCompartidos: 2, nivelConfianza: 'alta', pedidos: 2, total: 300, productos: ['Reloj'], primera: '2026-11-02T10:00:00Z', ultima: '2026-11-02T12:00:00Z', corroboradores: [] },
    ],
    reventa: [
      { vendedor: cuenta(37, 'Reventa Uno', 'r1@correo.com'), publicacion: { id: 116, nombre: 'Reloj de pared' }, originales: [{ vendedor: cuenta(36, 'Vendedor Original', 'vo@correo.com') }, { vendedor: cuenta(36, 'Vendedor Original', 'vo@correo.com') }], nivelConfianza: 'posible', corroboradores: [] },
    ],
    cuentasRelacionadas: [
      {
        clave: '30-31',
        miembros: [{ id: 30, nombre: 'Ana Pérez', ficha: ficha(30, 'Ana Pérez', 'ana@correo.com') }, { id: 31, nombre: 'Ana Pérez', ficha: ficha(31, 'Ana Pérez', 'ana.otra@correo.com') }],
        vinculos: [{ tipo: 'dispositivo', ids: [30, 31], referencia: 'abcd1234' }, { tipo: 'correo', ids: [30, 31] }, { tipo: 'dispositivo', ids: [30, 31], referencia: 'efgh5678' }],
        nivelConfianza: 'alta',
        corroboradores: [],
      },
    ],
    resenasCoordinadas: [{ usuario1: cuenta(10, 'Fraude Test1', 'f1@correo.com'), usuario2: cuenta(11, 'Fraude Test2', 'f2@correo.com'), productos: ['A', 'B', 'C'], productosCompartidos: 3 }],
    rafagaGasto: [{ usuario: LUIS, dia: '2026-11-03', nivelConfianza: 'posible', corroboradores: [] }],
    gastoAnomalo: [{ usuario: LUIS, compraId: 300, nivelConfianza: 'alta', corroboradores: [] }],
    categoriaInusual: [{ usuario: MARIA, compraId: 310, categoria: 'Hogar', nivelConfianza: 'posible', corroboradores: [] }],
    advertencias: [],
    ...extra,
  };
}

const casos = f.aplanarCasos(datos());
const caso = (clave) => casos.find((c) => c.clave === clave);
const vacio = f.FILTROS_VACIOS;
const con = (cambios) => ({ ...vacio, ...cambios });

// ---------- Aplanar las siete listas ----------

test('aplanar: sin datos (null, undefined, listas ausentes) no inventa casos', () => {
  assert.deepEqual(Array.from(f.aplanarCasos(undefined)), []);
  assert.deepEqual(Array.from(f.aplanarCasos(null)), []);
  assert.deepEqual(Array.from(f.aplanarCasos({ advertencias: [] })), []);
  assert.deepEqual(Array.from(f.aplanarCasos({ autocompra: [] })), []);
});

test('aplanar: sigue el orden de las secciones de la pantalla y conserva el del servidor dentro de cada una', () => {
  assert.deepEqual(Array.from(f.TIPOS, (t) => t.id), ['autocompra', 'reventa', 'persona', 'resenas', 'rafaga', 'gasto', 'categoria']);
  assert.deepEqual(claves(casos), [
    'autocompra:2-2', 'autocompra:24-25', 'autocompra:30-31',
    'reventa:37-116', 'persona:30-31', 'resenas:10-11', 'rafaga:2-2026-11-03', 'gasto:300', 'categoria:12-310-Hogar',
  ]);
  assert.deepEqual(Array.from(casos, (c) => c.tipo), ['autocompra', 'autocompra', 'autocompra', 'reventa', 'persona', 'resenas', 'rafaga', 'gasto', 'categoria']);
});

test('aplanar: la clave sale de los ids y no cambia si el servidor devuelve la lista en otro orden', () => {
  const alReves = f.aplanarCasos(datos({ autocompra: [...datos().autocompra].reverse() }));
  assert.deepEqual(new Set(claves(alReves)), new Set(claves(casos)));
});

test('aplanar: dos hallazgos con la misma clave se pueden elegir por separado', () => {
  const doble = f.aplanarCasos(datos({ gastoAnomalo: [{ usuario: LUIS, compraId: 300, nivelConfianza: 'alta' }, { usuario: LUIS, compraId: 300, nivelConfianza: 'posible' }] }));
  const gastos = Array.from(doble.filter((c) => c.tipo === 'gasto'), (c) => c.clave);
  assert.deepEqual(gastos, ['gasto:300', 'gasto:300~2']);
  assert.equal(new Set(claves(doble)).size, doble.length);
});

test('aplanar: el nivel es el del servidor, y las reseñas coordinadas (sin nivel) quedan en null', () => {
  assert.equal(caso('autocompra:30-31').nivel, 'alta');
  assert.equal(caso('autocompra:24-25').nivel, 'posible');
  assert.equal(caso('resenas:10-11').nivel, null);
  const raro = f.aplanarCasos(datos({ gastoAnomalo: [{ usuario: LUIS, compraId: 1, nivelConfianza: 'urgente' }] }));
  assert.equal(raro.find((c) => c.tipo === 'gasto').nivel, null);
});

test('aplanar: las cuentas salen con su correo de la ficha y sin repetirse', () => {
  const marta = caso('autocompra:24-25');
  assert.deepEqual(plano(marta.usuarios), [
    { id: 24, nombre: 'Marta Gómez', correo: 'marta@correo.com' },
    { id: 25, nombre: 'Marta Gomez', correo: 'marta.dos@correo.com' },
  ]);
  // Una cuenta que se compra a sí misma es UNA cuenta, no dos.
  assert.equal(caso('autocompra:2-2').usuarios.length, 1);
  // El vendedor original que vendió dos veces figura una sola vez.
  assert.deepEqual(Array.from(caso('reventa:37-116').usuarios, (u) => u.id), [37, 36]);
});

test('aplanar: una cuenta sin ficha (ya no existe) conserva su id y nombre, sin correo', () => {
  const sinFicha = f.aplanarCasos(datos({ gastoAnomalo: [{ usuario: cuenta(99, 'Borrada', null), compraId: 7, nivelConfianza: 'posible' }] }));
  assert.deepEqual(plano(sinFicha.find((c) => c.tipo === 'gasto').usuarios), [{ id: 99, nombre: 'Borrada', correo: '' }]);
});

test('aplanar: cómo se relacionan las cuentas (vínculos)', () => {
  assert.deepEqual(plano(caso('autocompra:2-2').vinculos), ['cuenta']);
  assert.deepEqual(plano(caso('autocompra:24-25').vinculos), ['dispositivo']);
  assert.deepEqual(plano(caso('autocompra:30-31').vinculos), ['dispositivo', 'correo', 'perfil']);
  // Dos vínculos de dispositivo en un mismo grupo cuentan una vez.
  assert.deepEqual(plano(caso('persona:30-31').vinculos), ['dispositivo', 'correo']);
  for (const clave of ['reventa:37-116', 'resenas:10-11', 'rafaga:2-2026-11-03', 'gasto:300', 'categoria:12-310-Hogar']) {
    assert.deepEqual(plano(caso(clave).vinculos), [], clave);
  }
});

test('aplanar: conserva el hallazgo original para dibujarlo', () => {
  assert.equal(caso('gasto:300').datos.compraId, 300);
  assert.equal(caso('persona:30-31').datos.clave, '30-31');
});

// ---------- Filtro por usuario ----------

test('normalizar: sin tildes, sin mayúsculas, sin espacios en los bordes', () => {
  assert.equal(f.normalizar('  María NÚÑEZ '), 'maria nunez');
  assert.equal(f.normalizar(null), '');
  assert.equal(f.normalizar(undefined), '');
});

test('usuario: vacío o solo espacios calza con todo', () => {
  assert.equal(f.filtrar(casos, con({ usuario: '' })).length, casos.length);
  assert.equal(f.filtrar(casos, con({ usuario: '   ' })).length, casos.length);
  assert.equal(f.filtrar(casos, con({ usuario: '#' })).length, casos.length);
});

test('usuario: por nombre, sin importar tildes ni mayúsculas', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'maria nunez' }))), ['categoria:12-310-Hogar']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'MARÍA' }))), ['categoria:12-310-Hogar']);
  // «Marta Gómez» y «Marta Gomez» (homónimas) aparecen las dos con «gomez».
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'gomez' }))), ['autocompra:24-25']);
});

test('usuario: por correo', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'luis.ramirez@example' }))), ['autocompra:2-2', 'rafaga:2-2026-11-03', 'gasto:300']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'ana.otra' }))), ['autocompra:30-31', 'persona:30-31']);
});

test('usuario: «#id» es esa cuenta y nada más (no el 2 dentro del 24 ni del 12)', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: '#2' }))), ['autocompra:2-2', 'rafaga:2-2026-11-03', 'gasto:300']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: '#24' }))), ['autocompra:24-25']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: '#999' }))), []);
});

test('usuario: un número sin # es la cuenta con ese id o un número dentro del nombre o del correo', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: '36' }))), ['reventa:37-116']);
  const conNumero = f.aplanarCasos(datos({ gastoAnomalo: [{ usuario: cuenta(500, 'Cuenta 77', 'x77@correo.com'), compraId: 8, nivelConfianza: 'posible' }] }));
  assert.deepEqual(claves(f.filtrar(conNumero, con({ usuario: '77' }))), ['gasto:8']);
});

test('usuario: todas las palabras deben calzar con la MISMA cuenta', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'ana perez' }))), ['autocompra:30-31', 'persona:30-31']);
  // «Luis» y «Núñez» son de cuentas distintas y no comparten ningún caso.
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'luis nunez' }))), []);
  // «marta@» solo está en el correo de la cuenta 24 y «.dos» solo en el de la 25: las dos están en el mismo caso pero son
  // cuentas distintas, así que no calza. Con palabras de una misma cuenta, sí.
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'marta@ .dos' }))), []);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'marta@ gomez' }))), ['autocompra:24-25']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'gomez .dos' }))), ['autocompra:24-25']);
});

test('usuario: un caso con varias cuentas aparece por cualquiera de ellas', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: '#37' }))), ['reventa:37-116']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: '#36' }))), ['reventa:37-116']);
});

// ---------- Filtros de probabilidad, relación y vínculo ----------

test('nivel: alta, posible y sin nivel', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ nivel: 'alta' }))), ['autocompra:30-31', 'persona:30-31', 'gasto:300']);
  assert.deepEqual(claves(f.filtrar(casos, con({ nivel: 'posible' }))), ['autocompra:2-2', 'autocompra:24-25', 'reventa:37-116', 'rafaga:2-2026-11-03', 'categoria:12-310-Hogar']);
  assert.deepEqual(claves(f.filtrar(casos, con({ nivel: 'sin' }))), ['resenas:10-11']);
});

test('relación: el tipo de hallazgo', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ relacion: 'autocompra' }))), ['autocompra:2-2', 'autocompra:24-25', 'autocompra:30-31']);
  assert.deepEqual(claves(f.filtrar(casos, con({ relacion: 'resenas' }))), ['resenas:10-11']);
  assert.deepEqual(claves(f.filtrar(casos, con({ relacion: 'persona' }))), ['persona:30-31']);
});

test('vínculo: cómo se relacionan las cuentas', () => {
  assert.deepEqual(claves(f.filtrar(casos, con({ vinculo: 'dispositivo' }))), ['autocompra:24-25', 'autocompra:30-31', 'persona:30-31']);
  assert.deepEqual(claves(f.filtrar(casos, con({ vinculo: 'correo' }))), ['autocompra:30-31', 'persona:30-31']);
  assert.deepEqual(claves(f.filtrar(casos, con({ vinculo: 'perfil' }))), ['autocompra:30-31']);
  assert.deepEqual(claves(f.filtrar(casos, con({ vinculo: 'cuenta' }))), ['autocompra:2-2']);
});

test('los filtros se combinan con Y, y sin ninguno devuelve todo', () => {
  assert.equal(f.filtrar(casos, vacio).length, casos.length);
  assert.deepEqual(claves(f.filtrar(casos, con({ nivel: 'posible', relacion: 'autocompra' }))), ['autocompra:2-2', 'autocompra:24-25']);
  assert.deepEqual(claves(f.filtrar(casos, con({ nivel: 'posible', relacion: 'autocompra', vinculo: 'dispositivo' }))), ['autocompra:24-25']);
  assert.deepEqual(claves(f.filtrar(casos, con({ usuario: 'luis', nivel: 'alta' }))), ['gasto:300']);
  assert.deepEqual(claves(f.filtrar(casos, con({ nivel: 'alta', relacion: 'resenas' }))), []);
});

test('el caso elegido no es un filtro: no oculta nada', () => {
  assert.equal(f.filtrar(casos, con({ caso: 'gasto:300' })).length, casos.length);
});

test('filtrar no modifica la lista de entrada ni devuelve la misma', () => {
  const antes = JSON.stringify(casos);
  const salida = f.filtrar(casos, con({ nivel: 'alta' }));
  assert.equal(JSON.stringify(casos), antes);
  assert.notEqual(salida, casos);
  assert.notEqual(f.filtrar(casos, vacio), casos);
});

// ---------- Conteos por opción ----------

test('conteos: total y visibles', () => {
  const c = f.conteos(casos, con({ nivel: 'alta' }));
  assert.equal(c.total, 9);
  assert.equal(c.visibles, 3);
});

test('conteos: cada filtro cuenta con los DEMÁS puestos, no con el suyo', () => {
  // Con relación=autocompra, las opciones de nivel cuentan solo autocompras…
  const c = f.conteos(casos, con({ relacion: 'autocompra' }));
  assert.deepEqual(plano(c.nivel), { todas: 3, posible: 2, alta: 1 });
  // …pero las de relación ignoran la relación elegida: se ve cuántos hay de cada tipo para poder cambiar de opinión.
  assert.equal(c.relacion.todas, 9);
  assert.equal(c.relacion.autocompra, 3);
  assert.equal(c.relacion.reventa, 1);
  assert.equal(c.relacion.resenas, 1);
});

test('conteos: nivel elegido recorta los conteos de relación y de vínculo', () => {
  const c = f.conteos(casos, con({ nivel: 'alta' }));
  assert.deepEqual(plano(c.relacion), { todas: 3, autocompra: 1, persona: 1, gasto: 1 });
  assert.deepEqual(plano(c.vinculo), { todas: 3, dispositivo: 2, correo: 2, perfil: 1 });
  assert.deepEqual(plano(c.nivel), { todas: 9, alta: 3, posible: 5, sin: 1 });
});

test('conteos: el vínculo elegido no recorta sus propias opciones (se puede cambiar de opinión)', () => {
  const c = f.conteos(casos, con({ vinculo: 'dispositivo' }));
  assert.deepEqual(plano(c.vinculo), { todas: 9, dispositivo: 3, correo: 2, perfil: 1, cuenta: 1 });
  // En cambio nivel y relación sí cuentan solo lo que tiene ese vínculo.
  assert.deepEqual(plano(c.relacion), { todas: 3, autocompra: 2, persona: 1 });
  assert.deepEqual(plano(c.nivel), { todas: 3, posible: 1, alta: 2 });
});

test('conteos: el usuario escrito también recorta las opciones', () => {
  const c = f.conteos(casos, con({ usuario: '#2' }));
  assert.deepEqual(plano(c.relacion), { todas: 3, autocompra: 1, rafaga: 1, gasto: 1 });
  assert.deepEqual(plano(c.nivel), { todas: 3, posible: 2, alta: 1 });
});

test('conteos: una opción con 0 casos no aparece (y «todas» siempre está)', () => {
  const c = f.conteos(casos, con({ relacion: 'resenas' }));
  assert.equal(c.nivel.alta, undefined);
  assert.equal(c.nivel.sin, 1);
  assert.equal(c.nivel.todas, 1);
  const nada = f.conteos([], vacio);
  assert.deepEqual(plano(nada.nivel), { todas: 0 });
  assert.equal(nada.total, 0);
  assert.equal(nada.visibles, 0);
});

test('conteos: elegir una opción con conteo > 0 nunca deja la lista vacía', () => {
  const elegidos = [con({ nivel: 'posible' }), con({ usuario: 'luis' }), con({ relacion: 'autocompra', vinculo: 'dispositivo' })];
  for (const actual of elegidos) {
    const c = f.conteos(casos, actual);
    for (const [clave, n] of Object.entries(c.relacion)) {
      if (clave === 'todas') continue;
      assert.equal(f.filtrar(casos, { ...actual, relacion: clave }).length, n, `relación ${clave}`);
    }
    for (const [clave, n] of Object.entries(c.nivel)) {
      if (clave === 'todas') continue;
      assert.equal(f.filtrar(casos, { ...actual, nivel: clave }).length, n, `nivel ${clave}`);
    }
    for (const [clave, n] of Object.entries(c.vinculo)) {
      if (clave === 'todas') continue;
      assert.equal(f.filtrar(casos, { ...actual, vinculo: clave }).length, n, `vínculo ${clave}`);
    }
  }
});

// ---------- Otros casos de las mismas cuentas ----------

test('relacionados: los otros casos de la misma cuenta, confianza alta primero', () => {
  const luis = caso('autocompra:2-2');
  assert.deepEqual(claves(f.relacionados(casos, luis)), ['gasto:300', 'rafaga:2-2026-11-03']);
});

test('relacionados: no incluye al propio caso y no inventa relaciones', () => {
  assert.deepEqual(claves(f.relacionados(casos, caso('resenas:10-11'))), []);
  for (const c of casos) assert.ok(!claves(f.relacionados(casos, c)).includes(c.clave), c.clave);
});

test('relacionados: a igual nivel respeta el orden de las secciones', () => {
  // Ana (30) y su gemela (31) están en la autocompra «alta» y en el grupo de cuentas «alta».
  assert.deepEqual(claves(f.relacionados(casos, caso('autocompra:30-31'))), ['persona:30-31']);
  assert.deepEqual(claves(f.relacionados(casos, caso('persona:30-31'))), ['autocompra:30-31']);
});

test('relacionados: una cuenta de un caso con varias cuentas trae los de cualquiera de ellas', () => {
  const lista = f.aplanarCasos(datos({ gastoAnomalo: [{ usuario: cuenta(36, 'Vendedor Original', 'vo@correo.com'), compraId: 55, nivelConfianza: 'posible' }] }));
  const reventa = lista.find((c) => c.tipo === 'reventa');
  assert.deepEqual(claves(f.relacionados(lista, reventa)), ['gasto:55']);
});

// ---------- La URL ----------

test('url: lee los filtros válidos y descarta lo desconocido', () => {
  const p = new URLSearchParams('usuario=Ana&nivel=alta&relacion=autocompra&vinculo=dispositivo&caso=gasto%3A300');
  assert.deepEqual(plano(f.leerFiltros(p)), { usuario: 'Ana', nivel: 'alta', relacion: 'autocompra', vinculo: 'dispositivo', caso: 'gasto:300' });
  const mal = new URLSearchParams('nivel=urgente&relacion=otra&vinculo=magia&usuario=x');
  assert.deepEqual(plano(f.leerFiltros(mal)), { usuario: 'x', nivel: '', relacion: '', vinculo: '', caso: '' });
  assert.deepEqual(plano(f.leerFiltros(new URLSearchParams(''))), plano(vacio));
});

test('url: el texto del usuario y el caso tienen largo máximo', () => {
  const largo = 'a'.repeat(500);
  const leidos = f.leerFiltros(new URLSearchParams({ usuario: largo, caso: largo }));
  assert.equal(leidos.usuario.length, f.LARGO_MAXIMO_USUARIO);
  assert.equal(leidos.caso.length, 160);
});

test('url: aParametros omite lo vacío y lo que es solo espacios', () => {
  assert.deepEqual(plano(f.aParametros(vacio)), {});
  assert.deepEqual(plano(f.aParametros(con({ usuario: '   ' }))), {});
  assert.deepEqual(plano(f.aParametros(con({ usuario: 'ana ', nivel: 'sin', caso: 'gasto:300' }))), { usuario: 'ana ', nivel: 'sin', caso: 'gasto:300' });
});

test('url: ida y vuelta sin pérdida', () => {
  const original = con({ usuario: 'ana pérez', nivel: 'posible', relacion: 'persona', vinculo: 'correo', caso: 'persona:30-31' });
  const ida = f.aParametros(original);
  assert.deepEqual(plano(f.leerFiltros(new URLSearchParams(plano(ida)))), plano(original));
});

test('url: hayFiltros ignora el caso elegido y el texto en blanco', () => {
  assert.equal(f.hayFiltros(vacio), false);
  assert.equal(f.hayFiltros(con({ caso: 'gasto:300' })), false);
  assert.equal(f.hayFiltros(con({ usuario: '  ' })), false);
  assert.equal(f.hayFiltros(con({ usuario: 'a' })), true);
  assert.equal(f.hayFiltros(con({ nivel: 'alta' })), true);
  assert.equal(f.hayFiltros(con({ relacion: 'rafaga' })), true);
  assert.equal(f.hayFiltros(con({ vinculo: 'cuenta' })), true);
});

test('url: los cambios devuelven un filtro nuevo y limpiar conserva el caso elegido', () => {
  const base = con({ usuario: 'ana', nivel: 'alta', relacion: 'gasto', vinculo: 'correo', caso: 'gasto:300' });
  assert.deepEqual(plano(f.sinFiltros(base)), plano(con({ caso: 'gasto:300' })));
  assert.equal(base.nivel, 'alta');
  assert.equal(f.conNivel(base, 'posible').nivel, 'posible');
  assert.equal(f.conRelacion(base, 'resenas').relacion, 'resenas');
  assert.equal(f.conVinculo(base, '').vinculo, '');
  assert.equal(f.conCaso(base, '').caso, '');
  assert.equal(f.conUsuario(base, 'x'.repeat(200)).usuario.length, f.LARGO_MAXIMO_USUARIO);
  assert.equal(f.conUsuario(base, null).usuario, '');
  assert.equal(base.usuario, 'ana');
});

// ---------- Texto ----------

test('duracionTexto: de minutos a días', () => {
  const t = (a, b) => f.duracionTexto(a, b);
  assert.equal(t('2026-11-01T10:00:00Z', '2026-11-01T10:00:20Z'), 'menos de un minuto');
  assert.equal(t('2026-11-01T10:00:00Z', '2026-11-01T10:45:00Z'), '45 min');
  assert.equal(t('2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z'), '2 h');
  assert.equal(t('2026-11-01T10:00:00Z', '2026-11-01T15:30:00Z'), '6 h'); // 5,5 h se redondea
  assert.equal(t('2026-11-01T00:00:00Z', '2026-11-02T06:00:00Z'), '30 h'); // hasta 48 horas se dice en horas
  assert.equal(t('2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z'), '2 días');
  assert.equal(t('2026-10-01T10:00:00Z', '2026-10-09T10:00:00Z'), '8 días');
  assert.equal(t('2026-11-01T12:00:00Z', '2026-11-01T10:00:00Z'), '2 h'); // el orden no importa
  assert.equal(t('nada', '2026-11-01T10:00:00Z'), '');
  assert.equal(t(null, undefined), '');
});
