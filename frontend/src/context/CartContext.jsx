import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { carritoApi } from '../api/carrito';
import { Toast } from '../components/common/Toast';

const CartContext = createContext(null);
const PENDIENTE_KEY = 'tiendaya_carrito_pendiente';

export function CartProvider({ children }) {
  const { usuario, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [notificacion, setNotificacion] = useState(null);
  const cerrarNotificacion = useCallback(() => setNotificacion(null), []);
  const avisarError = useCallback((err) => {
    setError(err.message);
    setNotificacion({ mensaje: err.message, tipo: 'error' });
  }, []);

  useEffect(() => {
    let vigente = true;
    if (!usuario) {
      setItems([]);
      return;
    }
    // CheckoutPage espera su revisión antes de habilitar el pago. El cleanup
    // impide que una lectura previa sobrescriba los datos recién revisados.
    if (location.pathname === '/checkout') return;
    setCargando(true);
    setError('');
    const pendienteRaw = sessionStorage.getItem(PENDIENTE_KEY);
    sessionStorage.removeItem(PENDIENTE_KEY);
    let pendiente;
    try { pendiente = JSON.parse(pendienteRaw); } catch { pendiente = null; }
    const carga = pendiente?.productoId && pendiente?.cantidad
      ? carritoApi.agregar(pendiente.productoId, pendiente.cantidad, token)
      : carritoApi.obtener(token);
    carga.then((carrito) => {
      if (!vigente) return;
      setItems(carrito.items);
      if (pendiente?.productoId) setNotificacion({ mensaje: 'Listo, agregamos tu producto al carrito.', tipo: 'exito' });
    }).catch((err) => { if (vigente) avisarError(err); })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [usuario, token, location.pathname, avisarError]);

  const refrescar = useCallback(async (revisar = false) => {
    if (!token) return;
    setCargando(true);
    setError('');
    try {
      const carrito = await (revisar ? carritoApi.revisar(token) : carritoApi.obtener(token));
      setItems(carrito.items);
      return carrito;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally { setCargando(false); }
  }, [token]);

  async function agregar(producto, cantidad = 1) {
    if (!usuario) {
      sessionStorage.setItem(PENDIENTE_KEY, JSON.stringify({ productoId: producto.id, cantidad, descripcion: producto.descripcion }));
      const next = encodeURIComponent(location.pathname + location.search);
      navigate(`/login?next=${next}`);
      return false;
    }
    setError('');
    try {
      const carrito = await carritoApi.agregar(producto.id, cantidad, token);
      setItems(carrito.items);
      setNotificacion({ mensaje: 'Producto añadido al carrito.', tipo: 'exito' });
      return true;
    } catch (err) { avisarError(err); return false; }
  }

  async function actualizarCantidad(productoId, cantidad) {
    setError('');
    try { setItems((await carritoApi.actualizarCantidad(productoId, cantidad, token)).items); }
    catch (err) { avisarError(err); }
  }

  async function quitar(productoId) {
    setError('');
    try { setItems((await carritoApi.quitar(productoId, token)).items); }
    catch (err) { avisarError(err); }
  }

  async function vaciar() {
    try { await carritoApi.vaciar(token); setItems([]); }
    catch (err) { avisarError(err); }
  }

  function limpiarLocal() { setItems([]); }
  const cantidadTotal = items.reduce((acc, it) => acc + it.cantidad, 0);
  const total = Math.round(items.reduce((acc, it) => acc + Number(it.producto.precio ?? 0) * it.cantidad, 0) * 100) / 100;
  const value = { items, agregar, actualizarCantidad, quitar, vaciar, limpiarLocal, refrescar, cantidadTotal, total, cargando, error };
  return (
    <CartContext.Provider value={value}>
      {children}
      <Toast mensaje={notificacion?.mensaje} tipo={notificacion?.tipo} onCerrar={cerrarNotificacion} />
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart debe usarse dentro de <CartProvider>');
  return ctx;
}
