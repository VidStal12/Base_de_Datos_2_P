import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
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
import { cargarIntento, renovarIntento, claveIntento, esResultadoCheckoutIncierto } from '../utils/checkoutIntento';
import { EstadoIntento } from '../components/checkout/EstadoIntento';
import { AvisoCheckoutInterrumpido } from '../components/checkout/AvisoCheckoutInterrumpido';

export function CheckoutPage() {
  const { token, usuario } = useAuth();
  const { items, total, limpiarLocal, refrescar, cargando: cargandoCarrito, error: errorCarrito } = useCart();
  const navigate = useNavigate();

  const [direcciones, setDirecciones] = useState([]);
  const [metodosPago, setMetodosPago] = useState([]);
  const [direccionId, setDireccionId] = useState(null);
  const [metodoPagoId, setMetodoPagoId] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [mostrarFormDireccion, setMostrarFormDireccion] = useState(false);
  const [mostrarFormPago, setMostrarFormPago] = useState(false);
  const [error, setError] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [pidiendoCompromiso, setPidiendoCompromiso] = useState(false);
  // Una cuenta bajo revisión confirma cada pedido con su contraseña (ver utils/restriccion.js):
  // el servidor lo pide al confirmar y esto guarda a qué pedido se refiere — con lo que ya
  // aceptó del compromiso — mientras el diálogo está abierto. null = no se está pidiendo.
  const [pidiendoContrasena, setPidiendoContrasena] = useState(null);
  const [intento, setIntento] = useState(null);
  const [avisoIntento, setAvisoIntento] = useState(false);
  const [consultandoIntento, setConsultandoIntento] = useState(false);
  const [mensajeConsulta, setMensajeConsulta] = useState('');
  const enCurso = useRef(false);
  const clave = claveIntento(usuario.id_usuario);

  useEffect(() => {
    let vigente = true;
    cargarIntento(clave, (datos) => checkoutApi.preparar(datos, token), token)
      .then(async (actual) => {
        if (!vigente) return null;
        setIntento(actual);
        if (actual.estado === 'completado') {
          sessionStorage.removeItem(clave);
          navigate(`/pedidos/${actual.compraId}`, { replace: true, state: { advertencias: actual.advertencias } });
          return null;
        }
        return Promise.all([direccionesApi.listar(token), metodosPagoApi.listar(token), refrescar(true)]);
      })
      .then((datos) => {
        if (!datos) return;
        const [dirs, metodos] = datos;
        if (!vigente) return;
        setDirecciones(dirs);
        setMetodosPago(metodos);
        if (dirs.length) setDireccionId(dirs[0].id);
        if (metodos.length) setMetodoPagoId(metodos[0].id);
        setMostrarFormDireccion(dirs.length === 0);
        setMostrarFormPago(metodos.length === 0);
      })
      .catch((err) => { if (vigente) setError(err.message); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [token, refrescar, clave, navigate]);

  async function revisarCompra() {
    if (enCurso.current || !intento) return;
    enCurso.current = true;
    setConfirmando(true);
    setError('');
    try {
      const actual = await renovarIntento(clave, intento, (datos) => checkoutApi.preparar(datos, token), token);
      setIntento(actual);
      setAvisoIntento(false);
      setMensajeConsulta('');
      if (actual.estado === 'completado') {
        navigate(`/pedidos/${actual.compraId}`, { state: { advertencias: actual.advertencias } });
        return;
      }
      await refrescar(true);
    } catch (err) { setError(err.message); }
    finally { enCurso.current = false; setConfirmando(false); }
  }

  async function consultarEstado() {
    if (enCurso.current || !intento) return;
    enCurso.current = true;
    setConsultandoIntento(true);
    setMensajeConsulta('');
    try {
      // Solo consulta el intento existente: no cancela, renueva ni confirma una compra.
      const actual = await checkoutApi.intento(intento.intentoId, token);
      setIntento(actual);
      if (actual.estado === 'completado') {
        limpiarLocal();
        sessionStorage.removeItem(clave);
        navigate(`/pedidos/${actual.compraId}`, { state: { advertencias: actual.advertencias } });
      } else if (actual.estado === 'pendiente') {
        setMensajeConsulta('Todavía no figura una compra confirmada para este intento. Podés volver a consultar o reintentar el mismo pedido.');
      }
    } catch (err) {
      setMensajeConsulta(esResultadoCheckoutIncierto(err)
        ? 'El servicio sigue sin responder. Tu intento permanece guardado; probá consultar nuevamente en unos instantes.'
        : err.message);
    } finally {
      enCurso.current = false;
      setConsultandoIntento(false);
    }
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

  // Una cuenta que puede vender tiene que aceptar el compromiso de no reventa
  // antes de pagar (ver utils/compromiso.js): el aviso se muestra primero y el
  // pedido sale recién cuando lo acepta. Los compradores confirman directo.
  function pedirConfirmacion() {
    if (puedeVender(usuario)) setPidiendoCompromiso(true);
    else confirmarPedido(false);
  }

  async function confirmarPedido(aceptaNoReventa, contrasena) {
    if (enCurso.current || !intento || intento.estado !== 'pendiente') return;
    enCurso.current = true;
    setError('');
    setPidiendoCompromiso(false);
    setConfirmando(true);
    try {
      const { compra, advertencias } = await checkoutApi.confirmar(
        {
          direccionId,
          metodoPagoId,
          intentoId: intento.intentoId,
          items: intento.items,
          ...(aceptaNoReventa && { aceptaNoReventa: true }),
          ...(contrasena && { contrasena }),
        },
        token
      );
      // El servidor ya vació SQL en la transacción. No borrar artículos añadidos después.
      limpiarLocal();
      sessionStorage.removeItem(clave);
      navigate(`/pedidos/${compra.id}`, { state: { recienCreado: true, advertencias } });
    } catch (err) {
      setAvisoIntento(esResultadoCheckoutIncierto(err));
      setMensajeConsulta('');
      // Si el servidor pide el compromiso (la interfaz tenía el rol desactualizado),
      // se vuelve a mostrar el aviso en vez de un error suelto.
      if (err.codigo === CODIGO_COMPROMISO) {
        setPidiendoContrasena(null);
        setPidiendoCompromiso(true);
      } else if (esRechazoDeContrasena(err)) {
        // La contraseña falta o es incorrecta: el carrito no cambió, así que no se refresca.
        setPidiendoContrasena({ aceptaNoReventa, error: errorDeContrasena(err) });
        return;
      } else {
        setPidiendoContrasena(null);
        setError(err.message);
      }
      // El carrito vacío puede significar que la compra sí se confirmó y se
      // perdió la respuesta. Consultar el intento antes de cambiar de compra.
      try {
        const actual = await checkoutApi.intento(intento.intentoId, token);
        setIntento(actual);
        if (actual.estado === 'completado') {
          limpiarLocal();
          sessionStorage.removeItem(clave);
          navigate(`/pedidos/${actual.compraId}`, { state: { advertencias: actual.advertencias } });
        }
      } catch { /* Conservar el intento cuando tampoco responde la consulta. */ }
    } finally {
      enCurso.current = false;
      setConfirmando(false);
    }
  }

  if (cargando || cargandoCarrito) return <Spinner />;
  if (intento && intento.estado !== 'pendiente') return <EstadoIntento intento={intento} procesando={confirmando} onNuevo={revisarCompra} error={error} />;
  if (!intento) return <p role="alert" className="py-8 text-danger-600">{error || 'No pudimos preparar la compra. Volvé a cargar la página para reintentar.'}</p>;
  if (errorCarrito) return <p role="alert" className="py-8 text-danger-600">{errorCarrito}</p>;
  if (items.length === 0) {
    return <p className="py-16 text-center text-neutral-600">Tu carrito está vacío.</p>;
  }
  const listoParaConfirmar = intento.estado === 'pendiente' && direccionId && metodoPagoId && !confirmando && !consultandoIntento && !items.some((item) => item.disponible === false);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      {avisoIntento && <AvisoCheckoutInterrumpido onConsultar={consultarEstado} consultando={consultandoIntento} confirmando={confirmando} mensajeConsulta={mensajeConsulta} />}
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

      <aside className="h-fit rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 font-bold text-neutral-900">Resumen del pedido</h2>
        <ul className="flex flex-col gap-2 text-sm text-neutral-600">
          {items.map(({ producto, cantidad }) => (
            <li key={producto.id} className="flex justify-between">
              <span className="line-clamp-1">
                {producto.nombre} × {cantidad}
              </span>
              <span>{formatCurrency(Number(producto.precio ?? 0) * cantidad)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-neutral-200 pt-3 text-lg">
          <span className="text-neutral-600">Total</span>
          <span className="font-bold text-neutral-900">{formatCurrency(total)}</span>
        </div>

        {error && !avisoIntento && <p role="alert" className="mt-3 text-sm text-danger-600">{error}</p>}
        {items.some((item) => item.disponible === false) && <p role="alert" className="mt-3 text-sm text-danger-600">Hay productos sin disponibilidad. Revisá el carrito.</p>}

        <Button
          variant="accent"
          disabled={!listoParaConfirmar}
          onClick={pedirConfirmacion}
          className="mt-4 w-full py-3"
        >
          {confirmando ? 'Confirmando...' : avisoIntento ? 'Reintentar mismo pedido' : 'Confirmar pedido'}
        </Button>
      </aside>

      {error && <Button variant="outline" disabled={confirmando || consultandoIntento} onClick={revisarCompra}>Revisar datos de compra</Button>}
      <CompromisoNoReventaModal
        abierto={pidiendoCompromiso}
        procesando={confirmando}
        onCancelar={() => setPidiendoCompromiso(false)}
        onAceptar={() => confirmarPedido(true)}
      />
      <ConfirmarContrasenaModal
        abierto={pidiendoContrasena !== null}
        error={pidiendoContrasena?.error}
        procesando={confirmando}
        onCancelar={() => setPidiendoContrasena(null)}
        onConfirmar={(contrasena) => confirmarPedido(pidiendoContrasena.aceptaNoReventa, contrasena)}
      />
    </div>
  );
}
