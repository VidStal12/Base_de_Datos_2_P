import { useEffect, useState } from 'react';
import { productosApi } from '../../api/productos';
import { ProductCard } from './ProductCard';

// Productos parecidos a uno (GET /api/productos/:id/relacionados, ver IA/ADR-006-recomendacion-semantica-vectorial.md).
// Se piden aparte y la sección se dibuja sola: si no hay con qué armarla (menos de 2 parecidos, el buscador y el
// catálogo apagados a la vez, o cualquier otro error) no deja nada en la página, ni siquiera un mensaje.
//
// `modo` dice de dónde salieron: 'semantico' (los vecinos del vector del producto) o 'subcategoria' (la misma
// subcategoría, cuando el buscador no responde o el producto todavía no tiene vector); la sección lo dice con
// sus palabras para que se sepa por qué se ofrecen esos productos. Quien lo usa le pone `key={productoId}`: al pasar
// de un producto a otro el componente se vuelve a montar, así que no se ve la lista del anterior mientras llega la nueva.
export function ProductosRelacionados({ productoId, titulo, token }) {
  const [datos, setDatos] = useState(null);

  useEffect(() => {
    let vigente = true;
    productosApi
      .relacionados(productoId, token)
      .then((respuesta) => vigente && setDatos(respuesta))
      .catch(() => vigente && setDatos(null));
    return () => {
      vigente = false;
    };
  }, [productoId, token]);

  if (!datos || datos.modo === 'ninguno' || !datos.productos?.length) return null;

  return (
    <section aria-labelledby="relacionados-titulo" className="flex flex-col gap-3">
      <div>
        <h2 id="relacionados-titulo" className="text-lg font-bold text-neutral-900">
          Productos relacionados
        </h2>
        <p className="text-sm text-neutral-500">
          {datos.modo === 'semantico'
            ? `Parecidos a «${titulo}» por lo que son, no solo por las palabras del título.`
            : `Misma subcategoría: ${datos.subcategoria}.`}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {datos.productos.map((producto) => (
          <ProductCard key={producto.id} producto={producto} />
        ))}
      </div>
    </section>
  );
}
