import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ofertasApi } from '../api/ofertas';
import { direccionesApi, metodosPagoApi, checkoutApi } from '../api/cuenta';
import { formatCurrency } from '../utils/format';
import { Button } from '../components/common/Button';
import { Spinner } from '../components/common/Spinner';
import { NuevaDireccionForm } from '../components/account/NuevaDireccionForm';
import { NuevoMetodoPagoForm } from '../components/account/NuevoMetodoPagoForm';
import { CompromisoNoReventaModal } from '../components/checkout/CompromisoNoReventaModal';
import { ConfirmarContrasenaModal } from '../components/checkout/ConfirmarContrasenaModal';
import { CODIGO_COMPROMISO, puedeVender } from '../utils/compromiso';
import { errorDeContrasena, esRechazoDeContrasena } from '../utils/restriccion';
import { cargarIntento, renovarIntento, claveIntento } from '../utils/checkoutIntento';
import { EstadoIntento } from '../components/checkout/EstadoIntento';

// Compra directa de una oferta flash — deliberadamente separada de
// CheckoutPage/CartContext (ver IA/ENTREGA-2-PLAN.md §4.2, "no reemplaza el
// checkout normal"): no pasa por el carrito, siempre es 1 unidad de un solo
// producto, al precio de oferta. Mismo layout que CheckoutPage a propósito
// (dirección + método de pago), para no reinventar esa parte.
export function OfertaCheckoutPage() {
  const { id } = useParams();
  const { token, usuario } = useAuth();
  const navigate = useNavigate();

  const [producto, setProducto] = useState(null);
  const [ofertaStock, setOfertaStock] = useState(null);
  const [direcciones, setDirecciones] = useState([]);
  const [metodosPago, setMetodosPago] = useState([]);
  const [direccionId, setDireccionId] = useState(null);
  const [metodoPagoId, setMetodoPagoId] = useState(null);
  const [mostrarFormDireccion, setMostrarFormDireccion] = useState(false);
  const [mostrarFormPago, setMostrarFormPago] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [pidiendoCompromiso, setPidiendoCompromiso] = useState(false);
  // Una cuenta bajo revisión confirma cada pedido con su contraseña (ver utils/restriccion.js);
  // null = no se está pidiendo.
  const [pidiendoContrasena, setPidiendoContrasena] = useState(null);
  const [intento, setIntento] = useState(null);
  const enCurso = useRef(false);
  const clave = claveIntento(usuario.id_usuario, id);

  useEffect(() => {
    let vigente = true;
    cargarIntento(clave, (datos) => ofertasApi.preparar(id, datos, token), token)
      .then(async (actual) => {
        if (!vigente) return null;
        setIntento(actual);
        if (actual.datos) {
          setDireccionId(actual.datos.direccionId);
          setMetodoPagoId(actual.datos.metodoPagoId);
        }
        if (actual.recuperado && actual.estado === 'completado') {
          sessionStorage.removeItem(clave);
          navigate(`/pedidos/${actual.compraId}`, { replace: true });
          return null;
        }
        return Promise.all([ofertasApi.consultarStock(id), direccionesApi.listar(token), metodosPagoApi.listar(token)]);
      })
      .then((datos) => {
        if (!vigente || !datos) return;
        const [stock, dirs, metodos] = datos;
        setProducto(stock.producto);
        setOfertaStock(stock);
        setDirecciones(dirs);
        setMetodosPago(metodos);
        if (dirs.length) setDireccionId((prev) => prev ?? dirs[0].id);
        if (metodos.length) setMetodoPagoId((prev) => prev ?? metodos[0].id);
        setMostrarFormDireccion(dirs.length === 0);
        setMostrarFormPago(metodos.length === 0);
      })
      .catch((err) => { if (vigente) setError(err.message); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [id, token, clave, navigate]);

  async function nuevaCompra() {
    if (enCurso.current || !intento) return;
    enCurso.current = true;
    setConfirmando(true);
    setError('');
    try {
      const actual = await renovarIntento(clave, intento, (datos) => ofertasApi.preparar(id, datos, token), token);
      setIntento(actual);
      if (actual.recuperado && actual.estado === 'completado') {
        navigate(`/pedidos/${actual.compraId}`);
        return;
      }
      const stock = await ofertasApi.consultarStock(id);
      setOfertaStock(stock);
      setProducto(stock.producto);
    } catch (err) { setError(err.message); }
    finally { enCurso.current = false; setConfirmando(false); }
  }

  async function crearDireccion(datos) {
    const nueva = await direccionesApi.crear(datos, token);
    setDirecciones((prev) => [...prev, nueva]);
    setDireccionId(nueva.id);
    setMostrarFormDireccion(false);
  }

  async function crearMetodoPago(datos) {
    const nuevo = await metodosPagoApi.crear(datos, token);
    setMetodosPago((prev) => [...prev, nuevo]);
    setMetodoPagoId(nuevo.id);
    setMostrarFormPago(false);
  }

  // Una cuenta que puede vender acepta primero el compromiso de no reventa (ver
  // utils/compromiso.js); los compradores confirman directo.
  function pedirConfirmacion() {
    if (puedeVender(usuario)) setPidiendoCompromiso(true);
    else confirmar(false);
  }

  async function confirmar(aceptaNoReventa, contrasena) {
    if (enCurso.current || !intento || intento.estado !== 'pendiente') return;
    enCurso.current = true;
    setError('');
    setPidiendoCompromiso(false);
    setConfirmando(true);
    try {
      const { compra } = await ofertasApi.comprar(
        id,
        {
          cantidad: 1,
          intentoId: intento.intentoId,
          direccionId,
          metodoPagoId,
          precioEsperado: intento.datos?.precioEsperado ?? ofertaStock.precio_oferta,
          ...(aceptaNoReventa && { aceptaNoReventa: true }),
          ...(contrasena && { contrasena }),
        },
        token
      );
      sessionStorage.removeItem(clave);
      navigate(`/pedidos/${compra.id}`, { state: { recienCreado: true } });
    } catch (err) {
      // El servidor pide el compromiso (rol desactualizado en la interfaz): se
      // vuelve a mostrar el aviso en vez de un error suelto.
      if (err.codigo === CODIGO_COMPROMISO) {
        setPidiendoContrasena(null);
        setPidiendoCompromiso(true);
      } else if (esRechazoDeContrasena(err)) {
        // La contraseña falta o es incorrecta: la oferta no cambió, no hace falta releerla.
        setPidiendoContrasena({ aceptaNoReventa, error: errorDeContrasena(err) });
        return;
      } else {
        setPidiendoContrasena(null);
        setError(err.message);
      }
      try {
        const actual = await checkoutApi.intento(intento.intentoId, token);
        setIntento(actual);
        if (actual.estado === 'completado') {
          sessionStorage.removeItem(clave);
          navigate(`/pedidos/${actual.compraId}`);
          return;
        }
      } catch { /* No iniciar otra compra cuando no se conoce el resultado. */ }
      // Alguien más pudo haberse quedado con la última unidad mientras esta
      // persona elegía dirección/pago — refrescar el remanente para que no
      // quede una pantalla ofreciendo algo que ya no existe.
      ofertasApi
        .consultarStock(id)
        .then((stock) => { setOfertaStock(stock); setProducto(stock.producto); })
        .catch(() => {});
    } finally {
      enCurso.current = false;
      setConfirmando(false);
    }
  }

  if (cargando) return <Spinner />;
  if (intento && intento.estado !== 'pendiente') return <EstadoIntento intento={intento} procesando={confirmando} onNuevo={nuevaCompra} error={error} />;
  if (!intento) return <p role="alert" className="py-8 text-danger-600">{error || 'No pudimos preparar la compra. Volvé a cargar la página para reintentar.'}</p>;
  if (error && !producto) {
    return <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>;
  }
  if (!ofertaStock?.activo || ofertaStock.restante <= 0) {
    return (
      <div className="rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600">
        Esta oferta ya no está disponible.{' '}
        <button onClick={() => navigate(`/productos/${id}`)} className="font-medium text-brand-700 hover:underline">
          Volver al producto
        </button>
      </div>
    );
  }

  const listoParaConfirmar = intento.estado === 'pendiente' && direccionId && metodoPagoId && !confirmando;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-6">
        <section>
          <h2 className="mb-3 text-lg font-bold text-neutral-900">1. Dirección de envío</h2>
          <div className="flex flex-col gap-2">
            {direcciones.map((dir) => (
              <label
                key={dir.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${
                  direccionId === dir.id ? 'border-brand-500 bg-brand-50' : 'border-neutral-200'
                }`}
              >
                <input type="radio" checked={direccionId === dir.id} onChange={() => setDireccionId(dir.id)} className="mt-1" />
                <span>
                  {dir.direccion}, {dir.pais} — {dir.codigo_postal}
                </span>
              </label>
            ))}
          </div>
          {mostrarFormDireccion ? (
            <div className="mt-3">
              <NuevaDireccionForm onCrear={crearDireccion} onCancelar={() => setMostrarFormDireccion(false)} />
            </div>
          ) : (
            <button onClick={() => setMostrarFormDireccion(true)} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              + Agregar otra dirección
            </button>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-bold text-neutral-900">2. Método de pago</h2>
          <div className="flex flex-col gap-2">
            {metodosPago.map((mp) => (
              <label
                key={mp.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${
                  metodoPagoId === mp.id ? 'border-brand-500 bg-brand-50' : 'border-neutral-200'
                }`}
              >
                <input type="radio" checked={metodoPagoId === mp.id} onChange={() => setMetodoPagoId(mp.id)} className="mt-1" />
                <span>
                  {mp.marca} terminada en {mp.ultimos_4_digitos} — {mp.titular}
                </span>
              </label>
            ))}
          </div>
          {mostrarFormPago ? (
            <div className="mt-3">
              <NuevoMetodoPagoForm onCrear={crearMetodoPago} onCancelar={() => setMostrarFormPago(false)} />
            </div>
          ) : (
            <button onClick={() => setMostrarFormPago(true)} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              + Agregar otro método de pago
            </button>
          )}
        </section>
      </div>

      <aside className="h-fit rounded-xl border border-accent-300 bg-accent-50 p-5">
        <span className="inline-block rounded-full bg-accent-600 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
          Oferta flash
        </span>
        {/* Todo esto sale de los datos de la oferta que guarda Redis (ver
            ofertaDatosService.js): imagen, vendedor y atributos ya no hay que
            pedirlos aparte al catálogo. */}
        {producto.imagen_url && (
          <img src={producto.imagen_url} alt={producto.descripcion} className="mt-3 aspect-square w-full rounded-lg bg-white object-cover" />
        )}
        <h2 className="mt-3 font-bold text-neutral-900">{producto.descripcion}</h2>
        {producto.vendedor_nombre && <p className="text-sm text-neutral-500">Vendido por {producto.vendedor_nombre}</p>}
        {producto.atributos?.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5 text-xs text-neutral-600">
            {producto.atributos.map((atributo) => (
              <li key={atributo.nombre} className="rounded-full bg-white px-2 py-0.5 ring-1 ring-accent-200">
                {atributo.nombre}: {atributo.valor}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-neutral-900">{formatCurrency(ofertaStock.precio_oferta)}</span>
          {producto.precio_normal != null && <span className="text-sm text-neutral-500 line-through">{formatCurrency(producto.precio_normal)}</span>}
        </div>
        <p className="mt-1 text-sm font-semibold text-accent-700">Quedan {ofertaStock.restante} al precio de oferta</p>

        {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}

        <Button variant="accent" disabled={!listoParaConfirmar} onClick={pedirConfirmacion} className="mt-4 w-full py-3">
          {confirmando ? 'Confirmando...' : 'Comprar ahora (1 unidad)'}
        </Button>
      </aside>

      {error && <Button variant="outline" disabled={confirmando} onClick={nuevaCompra}>Revisar datos de compra</Button>}
      <CompromisoNoReventaModal
        abierto={pidiendoCompromiso}
        procesando={confirmando}
        onCancelar={() => setPidiendoCompromiso(false)}
        onAceptar={() => confirmar(true)}
      />
      <ConfirmarContrasenaModal
        abierto={pidiendoContrasena !== null}
        error={pidiendoContrasena?.error}
        procesando={confirmando}
        onCancelar={() => setPidiendoContrasena(null)}
        onConfirmar={(contrasena) => confirmar(pidiendoContrasena.aceptaNoReventa, contrasena)}
      />
    </div>
  );
}
