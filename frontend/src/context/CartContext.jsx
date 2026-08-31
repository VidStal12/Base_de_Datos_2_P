import { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { carritoApi } from '../api/carrito';

// Carrito en Redis (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.1) — ya no vive en
// localStorage, requiere sesión iniciada (el backend clave el carrito por
// usuario.id_usuario, ver cartService.js). La interfaz pública del contexto
// (items, agregar, actualizarCantidad, quitar, vaciar, cantidadTotal, total)
// se mantuvo igual a propósito para no tener que tocar los componentes que
// ya lo consumen (Header, ProductCard, CheckoutPage) — lo que cambió es que
// ahora son todas async contra el backend, no mutaciones síncronas de estado
// local.
const CartContext = createContext(null);

export function CartProvider({ children }) {
  const { usuario, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!usuario) {
      // Sin sesión: no hay nada que pedirle al backend (la ruta exige
      // token). Vaciar el estado local es lo correcto acá — no significa
      // "vaciar el carrito real" del usuario, que sigue intacto en Redis
      // hasta que venza su TTL o vuelva a iniciar sesión.
      setItems([]);
      return;
    }
    setCargando(true);
    setError('');
    carritoApi
      .obtener(token)
      .then((c) => setItems(c.items))
      .catch(() => setError('No se pudo cargar el carrito.'))
      .finally(() => setCargando(false));
  }, [usuario, token]);

  // Mismo destino que RequireAuth.jsx, pero como chequeo inline en vez de un
  // guard de ruta completa: los botones "Agregar al carrito" viven en
  // páginas públicas (HomePage, ProductDetailPage), no se puede envolver un
  // botón individual en <RequireAuth>. El producto que se quería agregar no
  // se conserva a través del redirect — hay que agregarlo de nuevo después
  // de iniciar sesión (simplificación deliberada, no un olvido).
  function requerirSesion() {
    const next = encodeURIComponent(location.pathname + location.search);
    navigate(`/login?next=${next}`);
  }

  // Devuelve si el ítem se agregó de verdad — false si redirigió a login o
  // si el backend rechazó la request — para que quien llama (p. ej. "Comprar
  // ahora", que navega a /carrito después) no actúe como si hubiera
  // funcionado cuando en realidad no pasó nada.
  async function agregar(producto, cantidad = 1) {
    if (!usuario) {
      requerirSesion();
      return false;
    }
    setError('');
    try {
      const carrito = await carritoApi.agregar(producto.id, cantidad, token);
      setItems(carrito.items);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function actualizarCantidad(productoId, cantidad) {
    setError('');
    try {
      const carrito = await carritoApi.actualizarCantidad(productoId, cantidad, token);
      setItems(carrito.items);
    } catch (err) {
      setError(err.message);
    }
  }

  async function quitar(productoId) {
    setError('');
    try {
      const carrito = await carritoApi.quitar(productoId, token);
      setItems(carrito.items);
    } catch (err) {
      setError(err.message);
    }
  }

  // Llamado por CheckoutPage solo tras un checkout exitoso (dentro del
  // try, nunca del catch, y sin esperar esta promesa) — mismo comportamiento
  // que ya tenía antes de Redis: si el checkout falla, el carrito se
  // conserva. Atrapa su propio error a propósito: en ese punto el pedido ya
  // se confirmó, no tiene sentido que un fallo de red acá interrumpa nada —
  // en el peor caso el carrito queda vacío en el cliente igual (correcto,
  // el pedido ya se hizo) y la clave en Redis se limpia sola con el TTL.
  async function vaciar() {
    setItems([]);
    try {
      await carritoApi.vaciar(token);
    } catch (err) {
      console.error('No se pudo vaciar el carrito en el servidor:', err.message);
    }
  }

  const cantidadTotal = items.reduce((acc, it) => acc + it.cantidad, 0);
  const total = items.reduce((acc, it) => acc + Number(it.producto.inventario?.precio ?? 0) * it.cantidad, 0);

  const value = { items, agregar, actualizarCantidad, quitar, vaciar, cantidadTotal, total, cargando, error };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart debe usarse dentro de <CartProvider>');
  return ctx;
}
