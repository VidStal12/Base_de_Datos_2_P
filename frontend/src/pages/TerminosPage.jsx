import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Términos de Servicio (ruta pública /terminos). Cada regla que enuncia es una que
// el sistema aplica o vigila de verdad — compra propia, compromiso de no reventa,
// reseñas solo de compradores, revisión de fraude —; si una de ellas cambia en el
// backend, este texto cambia con ella y sube VERSION.
//
// Los `id` de SECCIONES son parte de la interfaz: otras pantallas enlazan a ellos
// (el aviso de compra y el detalle del pedido abren /terminos#no-reventa), así que
// renombrar uno obliga a actualizar esos enlaces. No se publican umbrales ni
// parámetros de las señales de fraude: decirle a alguien cuánto puede gastar sin
// que lo revisen sería enseñarle a esquivarlo.
const VERSION = '1.0';
const ACTUALIZADO = '4 de octubre de 2026';

// Enlace a otra sección de esta misma página. Es un <a> nativo a propósito: el
// navegador vuelve a bajar a la sección en cada clic, también si ya estás ahí.
function Ancla({ a, children }) {
  return (
    <a href={`#${a}`} className="font-medium text-brand-700 hover:underline">
      {children}
    </a>
  );
}

const SECCIONES = [
  {
    id: 'cuenta',
    titulo: 'El servicio y tu cuenta',
    contenido: (
      <>
        <p>
          TiendaYa es una tienda en línea donde vendedores publican productos y compradores los compran. Es un proyecto académico de la clase de Bases de Datos 2:
          no hay una pasarela de pago real conectada, así que los pagos se registran como aprobados de forma simulada y no se mueve dinero real.
        </p>
        <p>
          Para comprar, vender u opinar necesitás una cuenta. Los datos que das al registrarte tienen que ser verdaderos, y mantenerlos al día es tu responsabilidad.
          La cuenta es personal: cuidá tu contraseña, porque lo que se haga desde tu sesión se considera hecho por vos.
        </p>
        <ul>
          <li>
            <strong>Comprador:</strong> es la cuenta que crea cualquier persona al registrarse.
          </li>
          <li>
            <strong>Vendedor y administrador:</strong> pueden publicar productos. Las crea el equipo del proyecto; no se obtienen desde el registro público. El
            administrador además revisa la actividad del sitio.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'compras',
    titulo: 'Comprar',
    contenido: (
      <>
        <p>Los precios se muestran en quetzales (Q).</p>
        <p>
          Lo que cuenta es el precio y la disponibilidad al confirmar el pedido. El carrito no reserva inventario: si mientras tanto cambió el precio o se agotó el
          stock, te lo avisamos y te pedimos revisar antes de pagar. El precio que se cobra es siempre el que el servidor tiene vigente, nunca el que envíe tu
          navegador.
        </p>
        <p>
          Las ofertas flash y las recomendaciones tienen cupo limitado y vigencia. Se confirman al precio indicado mientras quede cupo; en las recomendaciones el
          cupo es personal, por producto.
        </p>
        <p>Cada pedido queda registrado en «Mis pedidos», con su detalle y la referencia del pago.</p>
      </>
    ),
  },
  {
    id: 'vender',
    titulo: 'Vender',
    contenido: (
      <>
        <p>Solo las cuentas de vendedor y de administrador pueden publicar productos. Si vendés en TiendaYa:</p>
        <ul>
          <li>Publicá únicamente productos que tengas derecho a vender, con una descripción, imágenes y atributos verdaderos.</li>
          <li>Mantené el precio y el stock al día, y respetá el precio y la vigencia de tus ofertas flash.</li>
          <li>
            <strong>No podés comprar tus propios productos.</strong> El sistema rechaza cualquier pedido que incluya uno tuyo, sin importar la vía: carrito, oferta
            flash o recomendación.
          </li>
          <li>
            Sí podés comprarle a otros vendedores, con la condición de no revender lo que comprás: ver <Ancla a="no-reventa">No reventa</Ancla>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'no-reventa',
    titulo: 'No reventa',
    destacada: true,
    contenido: (
      <>
        <p>
          Las cuentas que pueden vender (vendedor y administrador) pueden comprarle productos a otros vendedores, <strong>pero no revenderlos</strong>.
        </p>
        <ul>
          <li>
            <strong>Qué es revender:</strong> ofrecer a la venta, en TiendaYa o fuera de ella, un producto que compraste en TiendaYa a otro vendedor.
          </li>
          <li>
            <strong>Qué no es:</strong> comprar para uso propio, para consumirlo, para regalarlo o para analizarlo. Tampoco lo es publicar un producto tuyo que se le
            parezca: lo que importa es si volvés a ofrecer lo mismo que compraste.
          </li>
          <li>
            <strong>Tu compromiso en cada compra:</strong> antes de pagar te mostramos un aviso y tenés que marcar expresamente que lo entendés; sin eso el pedido no
            se completa. El pedido guarda la fecha y la hora en que aceptaste, y la podés ver en su detalle.
          </li>
          <li>
            <strong>Cómo lo revisamos:</strong> comparamos lo que compraste con lo que tenés publicado y activo en TiendaYa. Si hay un artículo equivalente, el caso
            pasa a revisión de una persona del equipo. La coincidencia se basa en la descripción del producto, así que un parecido no prueba nada por sí solo: cada
            caso se revisa antes de cualquier medida. Lo que pase fuera de TiendaYa no lo podemos ver.
          </li>
          <li>
            <strong>Si se confirma una reventa:</strong> TiendaYa se reserva el derecho de retirar las publicaciones involucradas y de restringir o suspender la cuenta.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'resenas',
    titulo: 'Reseñas',
    contenido: (
      <ul>
        <li>Solo puede reseñar un producto quien lo compró (con el pago aprobado), y una sola vez por producto.</li>
        <li>La reseña tiene que reflejar tu experiencia real con ese producto.</li>
        <li>No se permite coordinar reseñas con otras cuentas, dejarlas a cambio de algo, ni usar cuentas tuyas para opinar sobre tus propios productos.</li>
      </ul>
    ),
  },
  {
    id: 'conductas',
    titulo: 'Conductas que no se permiten',
    contenido: (
      <ul>
        <li>Comprarte a vos mismo, ya sea con tu cuenta o con otra tuya.</li>
        <li>Tener varias cuentas para inflar reseñas o para saltarte estas reglas.</li>
        <li>Usar las direcciones o los métodos de pago de otra persona, o hacerte pasar por ella.</li>
        <li>Manipular precios, cupos o inventario, o intentar acceder a datos o funciones que no corresponden a tu rol.</li>
      </ul>
    ),
  },
  {
    id: 'revision',
    titulo: 'Cómo revisamos la actividad sospechosa',
    contenido: (
      <>
        <p>
          Para proteger a quienes compran y venden usamos herramientas automáticas que buscan patrones que merecen una mirada humana: reseñas coordinadas, varias
          cuentas de una misma persona, compras entre cuentas relacionadas, reventa de lo comprado y gastos fuera de lo habitual de una cuenta.
        </p>
        <p>
          Una señal <strong>no es una acusación ni una sanción automática</strong>: es un motivo para que una persona del equipo administrador revise el caso. Un gasto
          alto o una compra grande, por sí solos, no son una infracción.
        </p>
        <p>
          Esas herramientas trabajan con las relaciones entre cuentas y productos (quién compró, reseñó o vende qué), el nombre normalizado y una huella irreversible
          del correo, no el correo en sí; no incluyen datos de pago ni direcciones. Al revisar un caso, un administrador puede ver los datos básicos de las cuentas
          involucradas: nombre, correo, rol, antigüedad, compras y reseñas.
        </p>
      </>
    ),
  },
  {
    id: 'cambios',
    titulo: 'Cambios a estos términos',
    contenido: (
      <p>
        Podemos actualizar estos términos. La versión vigente es la de esta página, con su número y su fecha arriba. Si seguís usando TiendaYa después de un cambio, se
        entiende que aceptás la versión nueva.
      </p>
    ),
  },
];

export function TerminosPage() {
  const { hash } = useLocation();

  // Esta página puede abrirse en una pestaña nueva (el aviso de compra lo hace para
  // no sacarte del pedido): el título tiene que decir qué es.
  useEffect(() => {
    const anterior = document.title;
    document.title = 'Términos de Servicio · TiendaYa';
    return () => {
      document.title = anterior;
    };
  }, []);

  // Un enlace como /terminos#no-reventa en una pestaña nueva llega antes de que React
  // haya dibujado la sección, así que el navegador no tiene adónde bajar: se baja
  // acá, ya con la página en pantalla.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold text-neutral-900">Términos de Servicio</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Versión {VERSION} · Última actualización: {ACTUALIZADO}
        </p>
        <p className="mt-4 text-neutral-700">Estas son las reglas para comprar, vender y opinar en TiendaYa. Al usar el sitio las aceptás.</p>
      </header>

      <section aria-labelledby="resumen" className="rounded-xl border border-brand-100 bg-brand-50 p-5">
        <h2 id="resumen" className="font-semibold text-brand-900">
          En resumen
        </h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-neutral-800">
          <li>Todo registro nuevo crea una cuenta de comprador. Las cuentas que pueden vender las crea el equipo.</li>
          <li>Nadie puede comprar sus propios productos.</li>
          <li>
            Quien puede vender también puede comprarle a otros vendedores, pero <strong>se compromete a no revender</strong> lo que compra: se lo pedimos en cada
            compra y queda constancia en el pedido. <Ancla a="no-reventa">Más abajo</Ancla>.
          </li>
          <li>Solo reseña quien compró el producto, una vez por producto.</li>
          <li>Revisamos señales de fraude con herramientas automáticas y con personas: una señal es un motivo para revisar, no una sanción.</li>
        </ul>
      </section>

      <nav aria-label="Contenido de los términos" className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Contenido</h2>
        <ol className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {SECCIONES.map((seccion, i) => (
            <li key={seccion.id}>
              <a href={`#${seccion.id}`} className="text-brand-700 hover:underline">
                {i + 1}. {seccion.titulo}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex flex-col gap-8 rounded-xl border border-neutral-200 bg-white p-6 sm:p-8">
        {SECCIONES.map((seccion, i) => (
          <section
            key={seccion.id}
            id={seccion.id}
            aria-labelledby={`${seccion.id}-titulo`}
            className={`scroll-mt-32 ${seccion.destacada ? 'rounded-lg border border-warning-500/40 bg-warning-500/5 p-5' : ''}`}
          >
            <h2 id={`${seccion.id}-titulo`} className="text-lg font-bold text-neutral-900">
              <span className="text-brand-600">{i + 1}.</span> {seccion.titulo}
            </h2>
            <div className="mt-3 space-y-3 leading-7 text-neutral-700 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:marker:text-neutral-400">
              {seccion.contenido}
            </div>
          </section>
        ))}
      </div>

      <Link to="/" className="text-sm font-medium text-brand-700 hover:underline">
        ← Volver al catálogo
      </Link>
    </article>
  );
}
