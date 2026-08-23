import { createContext, useContext, useEffect, useState } from 'react';

// El carrito vive solo en el cliente (localStorage) por ahora: el backend
// todavía no tiene endpoints de carrito — según el PRD esa pieza se migra a
// Redis en Entrega 2, así que no tenía sentido construir una versión relacional
// completa ahora para tirarla después. El checkout solo necesita la lista final
// de {productoId, cantidad}, que este carrito sabe producir igual.
const CartContext = createContext(null);
const STORAGE_KEY = 'tiendaya_carrito';

function cargarCarritoInicial() {
  try {
    const guardado = localStorage.getItem(STORAGE_KEY);
    return guardado ? JSON.parse(guardado) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(cargarCarritoInicial);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  function agregar(producto, cantidad = 1) {
    setItems((prev) => {
      const existente = prev.find((it) => it.producto.id === producto.id);
      const stock = producto.inventario?.cantidad ?? 0;
      if (existente) {
        const nuevaCantidad = Math.min(existente.cantidad + cantidad, stock);
        return prev.map((it) => (it.producto.id === producto.id ? { ...it, cantidad: nuevaCantidad } : it));
      }
      return [...prev, { producto, cantidad: Math.min(cantidad, stock) }];
    });
  }

  function actualizarCantidad(productoId, cantidad) {
    setItems((prev) =>
      prev
        .map((it) => (it.producto.id === productoId ? { ...it, cantidad } : it))
        .filter((it) => it.cantidad > 0)
    );
  }

  function quitar(productoId) {
    setItems((prev) => prev.filter((it) => it.producto.id !== productoId));
  }

  function vaciar() {
    setItems([]);
  }

  const cantidadTotal = items.reduce((acc, it) => acc + it.cantidad, 0);
  const total = items.reduce((acc, it) => acc + Number(it.producto.inventario?.precio ?? 0) * it.cantidad, 0);

  const value = { items, agregar, actualizarCantidad, quitar, vaciar, cantidadTotal, total };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart debe usarse dentro de <CartProvider>');
  return ctx;
}
