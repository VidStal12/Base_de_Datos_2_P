import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { recomendacionesApi } from '../api/recomendaciones';
import { direccionesApi, metodosPagoApi } from '../api/cuenta';
import { formatCurrency } from '../utils/format';
import { Button } from '../components/common/Button';
import { Spinner } from '../components/common/Spinner';
import { NuevaDireccionForm } from '../components/account/NuevaDireccionForm';
import { NuevoMetodoPagoForm } from '../components/account/NuevoMetodoPagoForm';
import { CompromisoNoReventaModal } from '../components/checkout/CompromisoNoReventaModal';
import { ConfirmarContrasenaModal } from '../components/checkout/ConfirmarContrasenaModal';
import { CODIGO_COMPROMISO, puedeVender } from '../utils/compromiso';
import { errorDeContrasena, esRechazoDeContrasena } from '../utils/restriccion';

// Compra directa de una recomendación por tendencia — mismo layout que
// OfertaCheckoutPage.jsx (dirección + método de pago), pero contra
// /api/recomendaciones en vez de /api/ofertas: el precio y la elegibilidad
// salen del análisis del historial del usuario, no de una oferta que un
// vendedor configuró (ver IA/ENTREGA-2-PLAN.md §4.5). Siempre 1 unidad, igual
// que la oferta flash — el cupo personal (2) existe para dobles clics/
// reintentos, no para compras grandes.
export function RecomendacionCheckoutPage() {
  const { id } = useParams();
  const { token, usuario } = useAuth();
  const navigate = useNavigate();

  const [recomendaciones, setRecomendaciones] = useState(null);
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

  useEffect(() => {
    Promise.all([recomendacionesApi.obtener(token), direccionesApi.listar(token), metodosPagoApi.listar(token)])
      .then(([recs, dirs, metodos]) => {
        setRecomendaciones(recs);
        setDirecciones(dirs);
        setMetodosPago(metodos);
        if (dirs.length) setDireccionId(dirs[0].id);
        if (metodos.length) setMetodoPagoId(metodos[0].id);
        setMostrarFormDireccion(dirs.length === 0);
        setMostrarFormPago(metodos.length === 0);
      })
      .catch(() => setError('No pudimos cargar esta recomendación.'))
      .finally(() => setCargando(false));
  }, [id, token]);

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
    setError('');
    setPidiendoCompromiso(false);
    setConfirmando(true);
    try {
      const { compra } = await recomendacionesApi.comprar(
        id,
        { cantidad: 1, direccionId, metodoPagoId, ...(aceptaNoReventa && { aceptaNoReventa: true }), ...(contrasena && { contrasena }) },
        token
      );
      navigate(`/pedidos/${compra.id}`, { state: { recienCreado: true } });
    } catch (err) {
      // El servidor pide el compromiso (rol desactualizado en la interfaz): se
      // vuelve a mostrar el aviso en vez de un error suelto.
      if (err.codigo === CODIGO_COMPROMISO) {
        setPidiendoContrasena(null);
        setPidiendoCompromiso(true);
      } else if (esRechazoDeContrasena(err)) {
        setPidiendoContrasena({ aceptaNoReventa, error: errorDeContrasena(err) });
      } else {
        setPidiendoContrasena(null);
        setError(err.message);
      }
    } finally {
      setConfirmando(false);
    }
  }

  if (cargando) return <Spinner />;
  if (error && !recomendaciones) {
    return <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>;
  }

  const producto = recomendaciones?.productos.find((p) => String(p.id) === String(id));
  if (!producto) {
    return (
      <div className="rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600">
        Esta recomendación ya no está vigente para tu usuario.{' '}
        <button onClick={() => navigate('/')} className="font-medium text-brand-700 hover:underline">
          Volver al catálogo
        </button>
      </div>
    );
  }

  const listoParaConfirmar = direccionId && metodoPagoId && !confirmando;

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
          Recomendado para vos
        </span>
        <h2 className="mt-3 font-bold text-neutral-900">{producto.descripcion}</h2>
        <p className="text-sm text-neutral-500">{producto.vendedor_nombre}</p>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-neutral-900">{formatCurrency(producto.precio_recomendado)}</span>
          <span className="text-sm text-neutral-500 line-through">{formatCurrency(producto.precio_normal)}</span>
        </div>

        {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}

        <Button variant="accent" disabled={!listoParaConfirmar} onClick={pedirConfirmacion} className="mt-4 w-full py-3">
          {confirmando ? 'Confirmando...' : 'Comprar ahora (1 unidad)'}
        </Button>
      </aside>

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
