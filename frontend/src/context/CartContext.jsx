import { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { carritoApi } from '../api/carrito';
import { Toast } from '../components/common/Toast';

// Carrito en Redis (Entrega 2, ver IA/ENTREGA-2-PLAN.md §4.1) — ya no vive en
// localStorage, requiere sesión iniciada (el backend clave el carrito por
// usuario.id_usuario, ver cartService.js). La interfaz pública del contexto
// (items, agregar, actualizarCantidad, quitar, vaciar, cantidadTotal, total)
// se mantuvo igual a propósito para no tener que tocar los componentes que
// ya lo consumen (Header, ProductCard, CheckoutPage) — lo que cambió es que
// ahora son todas async contra el backend, no mutaciones síncronas de estado
// local.
const CartContext = createContext(null);

// "Agregar al carrito" pendiente de iniciar sesión — se guarda acá (no en
// memoria) porque requerirSesion() navega a /login, que desmonta y remonta
// componentes; sessionStorage sobrevive esa navegación dentro de la misma
// pestaña y se limpia solo si la pestaña se cierra, que es exactamente el
// alcance que tiene sentido para algo tan efímero como esto.
const PENDIENTE_KEY = 'tiendaya_carrito_pendiente';

export function CartProvider({ children }) {
  const { usuario, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [mensaje, setMensaje] = useState('');

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

    // Si había un "agregar al carrito" pendiente de antes de iniciar sesión,
    // completarlo ahora en vez de simplemente traer el carrito tal cual
    // estaba — así "continuar donde lo dejaste" funciona de verdad: no hace
    // falta volver a tocar "Agregar al carrito" después de loguearse. Se
    // borra ANTES de intentarlo, no después, para no reintentarlo en un
    // refresh si algo sale mal a mitad de camino.
    const pendienteRaw = sessionStorage.getItem(PENDIENTE_KEY);
    if (pendienteRaw) {
      sessionStorage.removeItem(PENDIENTE_KEY);
      let pendiente = null;
      try {
        pendiente = JSON.parse(pendienteRaw);
      } catch {
        pendiente = null;
      }
      if (pendiente?.productoId && pendiente?.cantidad) {
        carritoApi
          .agregar(pendiente.productoId, pendiente.cantidad, token)
          .then((carrito) => {
            setItems(carrito.items);
            setMensaje(
              pendiente.descripcion ? `Listo, agregamos "${pendiente.descripcion}" a tu carrito.` : 'Listo, agregamos tu producto al carrito.'
            );
          })
          .catch(() => setError('No se pudo completar lo que estabas agregando al carrito — probá de nuevo.'))
          .finally(() => setCargando(false));
        return;
      }
    }

    carritoApi
      .obtener(token)
      .then((c) => setItems(c.items))
      .catch(() => setError('No se pudo cargar el carrito.'))
      .finally(() => setCargando(false));
  }, [usuario, token]);

  // Mismo destino que RequireAuth.jsx, pero como chequeo inline en vez de un
  // guard de ruta completa: los botones "Agregar al carrito" viven en
  // páginas públicas (HomePage, ProductDetailPage), no se puede envolver un
  // botón individual en <RequireAuth>. `pendiente`, si se pasa, es lo que el
  // efecto de arriba va a completar apenas haya sesión.
  function requerirSesion(pendiente) {
    if (pendiente) {
      sessionStorage.setItem(PENDIENTE_KEY, JSON.stringify(pendiente));
    }
    const next = encodeURIComponent(location.pathname + location.search);
    navigate(`/login?next=${next}`);
  }

  // Devuelve si el ítem se agregó de verdad — false si redirigió a login o
  // si el backend rechazó la request — para que quien llama (p. ej. "Comprar
  // ahora", que navega a /carrito después) no actúe como si hubiera
  // funcionado cuando en realidad no pasó nada.
  async function agregar(producto, cantidad = 1) {
    if (!usuario) {
      requerirSesion({ productoId: producto.id, cantidad, descripcion: producto.descripcion });
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

  return (
    <CartContext.Provider value={value}>
      {children}
      <Toast mensaje={mensaje} onCerrar={() => setMensaje('')} />
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart debe usarse dentro de <CartProvider>');
  return ctx;
}
