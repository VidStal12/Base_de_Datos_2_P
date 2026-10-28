import { useEffect, useState } from 'react';
import { busquedaApi } from '../../api/busqueda';
import { Carrusel } from '../common/Carrusel';
import { IconoPremio } from '../common/iconos';
import { ProductCard } from '../product/ProductCard';
import { SeccionWidget } from './SeccionWidget';

// Los más vendidos: la misma consulta del catálogo (GET /api/busqueda) ordenada por ventas y de tamaño corto. Si no se
// puede leer o no hay nada, la sección no se dibuja: el catálogo de abajo ya muestra los productos.
export function MasVendidosCarrusel() {
  const [estado, setEstado] = useState({ productos: [], cargando: true });

  useEffect(() => {
    let vigente = true;
    busquedaApi
      .buscar({ ordenarPor: 'masVendidos', tamano: '12' })
      .then((respuesta) => {
        if (vigente) setEstado({ productos: respuesta.resultados ?? [], cargando: false });
      })
      .catch(() => {
        if (vigente) setEstado({ productos: [], cargando: false });
      });
    return () => {
      vigente = false;
    };
  }, []);

  if (!estado.cargando && estado.productos.length === 0) return null;

  return (
    <SeccionWidget
      id="mas-vendidos"
      icono={<IconoPremio className="size-5 text-brand-600" />}
      titulo="Más vendidos"
      descripcion="Lo que más se está llevando la gente."
      enlace={{ to: '/?ordenarPor=masVendidos', texto: 'Ver más vendidos' }}
    >
      <Carrusel etiqueta="Productos más vendidos" cargando={estado.cargando}>
        {estado.productos.map((producto) => (
          <ProductCard key={producto.id} producto={producto} />
        ))}
      </Carrusel>
    </SeccionWidget>
  );
}
