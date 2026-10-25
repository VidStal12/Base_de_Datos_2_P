// Lista blanca de la API (IA/PLAN-ENTREGA-FINAL.md §4.0): TODA ruta que expone el backend figura acá con el
// acceso que exige. tests/accesoRutas.test.js recorre el router real y falla si una ruta no está en esta lista,
// si el acceso declarado no es el que la ruta de verdad exige, o si una ruta declarada ya no existe. Así un
// endpoint nuevo nunca queda abierto «por olvido»: o se declara acá, o la suite no pasa.
//
//   publica   sin sesión; el token, si llega, ni se mira.
//   opcional  también sirve sin sesión; con una sesión válida la respuesta puede cambiar (optionalAuth).
//   sesion    requireAuth: cualquier rol, con la cuenta sin suspender.
//   roles     requireAuth + requireRole(...roles).
//   propios   además, el servicio comprueba que el recurso de la URL sea de quien pregunta (o que sea
//             administrador). La prueba no puede verlo en el código: lo cubren tests/accesoApi.test.js y
//             las pruebas de cada servicio.
//
// Las rutas por roles llevan además lo que necesita la pantalla /admin/permisos (IA/ADR-007 §9):
//   grupo     el módulo al que pertenecen, para agruparlas en la matriz.
//   editable  un administrador puede cambiar desde la pantalla QUÉ ROLES entran (la lista `roles` de acá es la
//             base; las diferencias se guardan en la tabla acl_regla). Lo editable se declara a propósito:
//   fija      el texto de por qué NO se puede cambiar (depende de algo que el servicio comprueba aparte, como el
//             dueño del producto o el compromiso de no reventa, o es la administración de los permisos misma).
//             Una ruta por roles es `editable` o lleva `fija`; nunca las dos ni ninguna (lo prueba accesoRutas).
//   El administrador conserva siempre todas las rutas: la pantalla no puede quitárselas.

const ROLES = ['comprador', 'vendedor', 'administrador'];
const VENDEDORES = ['vendedor', 'administrador'];
const ADMINISTRADOR = ['administrador'];

const publica = (metodo, ruta, nota) => ({ metodo, ruta, acceso: 'publica', nota });
const opcional = (metodo, ruta, nota) => ({ metodo, ruta, acceso: 'opcional', nota });
const sesion = (metodo, ruta, nota, { propios = false } = {}) => ({ metodo, ruta, acceso: 'sesion', propios, nota });
const roles = (metodo, ruta, rolesPermitidos, nota, { propios = false, grupo, editable = false, fija } = {}) => ({
  metodo,
  ruta,
  acceso: 'roles',
  roles: rolesPermitidos,
  propios,
  grupo,
  editable,
  fija,
  nota,
});

// Las rutas de la administración de permisos: solo el administrador, y no se pueden conceder. Si se pudieran,
// quien reciba una de ellas podría concederse todo lo demás (en Kubernetes es el verbo `escalate`).
const SOLO_ADMINISTRADOR = 'Administrar permisos, roles y cuentas es lo único que no se concede: quien recibiera estas rutas podría concederse todo lo demás.';
const DEL_DUENO = 'El servicio comprueba además que el producto sea del vendedor (o que sea administrador): un rol nuevo no tiene «dueño» que comprobar.';

const RUTAS = [
  // Índice y salud
  publica('GET', '/', 'Índice de la API'),
  publica('GET', '/api/health', 'Estoy vivo: no toca ninguna base'),
  opcional('GET', '/api/health/componentes', 'Público: solo ok por base; un administrador recibe además los milisegundos y el texto del error'),

  // Cuenta
  publica('POST', '/api/auth/registro', 'Alta de cuenta'),
  publica('POST', '/api/auth/login', 'Inicio de sesión'),
  sesion('GET', '/api/auth/me', 'Perfil de quien pregunta'),

  // Direcciones y métodos de pago: todo el router exige sesión y trabaja sobre el usuario del token
  sesion('POST', '/api/direcciones', 'Crea una dirección de quien pregunta'),
  sesion('GET', '/api/direcciones', 'Lista solo las de quien pregunta'),
  sesion('DELETE', '/api/direcciones/:id', 'Solo si es suya (y sin pedidos asociados)', { propios: true }),
  sesion('POST', '/api/metodos-pago', 'Crea un método de pago de quien pregunta'),
  sesion('GET', '/api/metodos-pago', 'Lista solo los de quien pregunta'),
  sesion('DELETE', '/api/metodos-pago/:id', 'Solo si es suyo (y sin pagos asociados)', { propios: true }),

  // Categorías: un vendedor las crea al publicar (decisión documentada; PLAN-ENTREGA-FINAL.md §4.1, fila 5)
  publica('GET', '/api/categorias', 'Árbol de categorías'),
  roles('POST', '/api/categorias', VENDEDORES, 'Crea una categoría', { grupo: 'Catálogo', editable: true }),
  roles('POST', '/api/categorias/:id/subcategorias', VENDEDORES, 'Crea una subcategoría', { grupo: 'Catálogo', editable: true }),
  roles('POST', '/api/categorias/subcategorias/:id/atributos', VENDEDORES, 'Crea un atributo de una subcategoría', { grupo: 'Catálogo', editable: true }),

  // Productos y reseñas
  opcional('GET', '/api/productos', 'Catálogo público; los inactivos solo los ven su vendedor dueño y el administrador (lo dice el token, no un parámetro)'),
  roles('GET', '/api/productos/estadisticas/ediciones', ADMINISTRADOR, 'Productos más editados (panel administrativo)', { grupo: 'Catálogo', editable: true }),
  opcional('GET', '/api/productos/:id', 'Detalle público; el producto de un vendedor suspendido solo lo ve un administrador'),
  opcional('GET', '/api/productos/:id/relacionados', 'Productos parecidos por significado; sin lo oculto ni lo inactivo y, con sesión, sin los del propio vendedor'),
  roles('GET', '/api/productos/:id/historial', VENDEDORES, 'Historial de precios y stock: solo el vendedor dueño o un administrador', { propios: true, grupo: 'Productos del vendedor', fija: DEL_DUENO }),
  publica('GET', '/api/productos/:id/resenas', 'Reseñas con el autor como alias, sin id de cuenta'),
  sesion('POST', '/api/productos/:id/resenas', 'Cualquier rol con sesión reseña, una vez por producto'),
  roles('POST', '/api/productos', VENDEDORES, 'Publica un producto propio', { grupo: 'Productos del vendedor', fija: 'Publicar exige haber aceptado el compromiso de no reventa, que el servicio liga a los roles vendedor y administrador.' }),
  roles('PATCH', '/api/productos/:id', VENDEDORES, 'Edita un producto: solo el dueño o un administrador', { propios: true, grupo: 'Productos del vendedor', fija: DEL_DUENO }),

  // Carrito: todo el router exige sesión
  sesion('GET', '/api/carrito', 'Carrito de quien pregunta'),
  sesion('POST', '/api/carrito/revisar', 'Revisa precios y disponibilidad al entrar al checkout'),
  sesion('POST', '/api/carrito/items', 'Agrega un producto al carrito'),
  sesion('PATCH', '/api/carrito/items/:productoId', 'Fija la cantidad de una línea'),
  sesion('DELETE', '/api/carrito/items/:productoId', 'Quita una línea'),
  sesion('DELETE', '/api/carrito', 'Vacía el carrito'),

  // Checkout y pedidos
  sesion('POST', '/api/checkout/intentos', 'Prepara o recupera el intento de la versión actual del carrito'),
  sesion('GET', '/api/checkout/intentos/:id', 'Estado del intento: solo su propietario', { propios: true }),
  sesion('POST', '/api/checkout/intentos/:id/cancelar', 'Cancela un intento: solo su propietario', { propios: true }),
  sesion('POST', '/api/checkout', 'Confirma el pedido (idempotente); aplica los topes de controlPedidos'),
  sesion('GET', '/api/compras', 'Pedidos de quien pregunta'),
  sesion('GET', '/api/compras/:id', 'Detalle de un pedido: solo si es suyo', { propios: true }),

  // Administración
  roles('GET', '/api/admin/ventas', ADMINISTRADOR, 'Panel de ventas por intervalos (Cassandra)', { grupo: 'Ventas', editable: true }),
  roles('GET', '/api/admin/fraude', ADMINISTRADOR, 'Señales de posible fraude (Neo4j)', { grupo: 'Fraude', editable: true }),
  roles('GET', '/api/admin/bloqueos', ADMINISTRADOR, 'Cuentas suspendidas y bajo vigilancia, con su historial', { grupo: 'Cuentas suspendidas', editable: true }),
  roles('POST', '/api/admin/bloqueos/evaluar', ADMINISTRADOR, 'Corre ahora el barrido de suspensiones', { grupo: 'Cuentas suspendidas', editable: true }),
  roles('POST', '/api/admin/bloqueos/:usuarioId/liberar', ADMINISTRADOR, 'Levanta una suspensión (falso positivo)', { grupo: 'Cuentas suspendidas', editable: true }),
  roles('POST', '/api/admin/bloqueos/:usuarioId/quitar-restriccion', ADMINISTRADOR, 'Quita los límites suaves de una cuenta', { grupo: 'Cuentas suspendidas', editable: true }),
  roles('POST', '/api/admin/bloqueos/:usuarioId/extender', ADMINISTRADOR, 'Suma horas a una suspensión', { grupo: 'Cuentas suspendidas', editable: true }),
  roles('POST', '/api/admin/recalcular-ventas', ADMINISTRADOR, 'Recalcula total_vendido desde MySQL', { grupo: 'Mantenimiento', editable: true }),
  roles('POST', '/api/admin/recalcular-inventario', ADMINISTRADOR, 'Recalcula precio y cantidad desde MySQL', { grupo: 'Mantenimiento', editable: true }),

  // Permisos, roles y cuentas (la pantalla /admin/permisos): solo el administrador, siempre
  roles('GET', '/api/admin/permisos', ADMINISTRADOR, 'La matriz de permisos: roles, rutas, lo que declara el código y lo que cambió un administrador', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('PUT', '/api/admin/permisos', ADMINISTRADOR, 'Aplica un lote de cambios de permisos (todo o nada) y los audita', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('POST', '/api/admin/permisos/restaurar', ADMINISTRADOR, 'Vuelve una ruta, un rol o todo a lo que declara el código', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('GET', '/api/admin/permisos/simular', ADMINISTRADOR, 'Simulador: ¿puede este rol (o esta cuenta) hacer esto? Responde con la misma decisión que la API aplica', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('POST', '/api/admin/roles', ADMINISTRADOR, 'Crea un rol nuevo, sin permisos más que los de un comprador', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('DELETE', '/api/admin/roles/:id', ADMINISTRADOR, 'Borra un rol creado por un administrador (solo si nadie lo usa)', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('GET', '/api/admin/usuarios', ADMINISTRADOR, 'Cuentas con su rol, con búsqueda y paginación', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('PATCH', '/api/admin/usuarios/:id/rol', ADMINISTRADOR, 'Cambia el rol de una cuenta (no la propia, y siempre queda otro administrador)', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('GET', '/api/admin/auditoria', ADMINISTRADOR, 'Registro de cambios de permisos y de accesos denegados, con filtros', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),
  roles('GET', '/api/admin/auditoria/exportar', ADMINISTRADOR, 'El mismo registro, en CSV', { grupo: 'Permisos y cuentas', fija: SOLO_ADMINISTRADOR }),

  // Ofertas flash
  publica('GET', '/api/ofertas/:productoId/stock', 'Remanente en vivo de una oferta'),
  roles('PATCH', '/api/ofertas/:productoId', VENDEDORES, 'Configura o pausa la oferta: solo el dueño del producto o un administrador', { propios: true, grupo: 'Productos del vendedor', fija: DEL_DUENO }),
  sesion('POST', '/api/ofertas/:productoId/intentos', 'Prepara el intento de compra de una oferta'),
  sesion('POST', '/api/ofertas/:productoId/comprar', 'Compra de una oferta (idempotente); aplica los topes de controlPedidos'),

  // Recomendaciones: siempre sobre el usuario del token
  sesion('GET', '/api/recomendaciones', 'Recomendaciones de quien pregunta'),
  sesion('POST', '/api/recomendaciones/:productoId/comprar', 'Compra de un producto recomendado; aplica los topes de controlPedidos'),

  // Búsqueda
  opcional('GET', '/api/busqueda', 'Búsqueda y navegación públicas; con sesión, sugerencias personalizadas si el texto no encuentra nada'),
  publica('GET', '/api/busqueda/sugerencias', 'Autocompletado'),
];

const clave = (r) => `${r.metodo} ${r.ruta}`;

// Lo que usa la pantalla de permisos y el middleware: la ruta por su clave («GET /api/admin/ventas»).
const PORCLAVE = new Map(RUTAS.map((r) => [clave(r), r]));
const rutaPorClave = (c) => PORCLAVE.get(c);

module.exports = { RUTAS, ROLES, clave, rutaPorClave };
