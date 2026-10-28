import { useEffect, useState } from 'react';
import { productosApi } from '../api/productos';
import { ofertasApi } from '../api/ofertas';
import { normalizarOferta, primerasEnTerminar, proximoVencimiento } from '../utils/ofertas';

const MAXIMO_TEMPORIZADOR = 2 ** 31 - 1; // setTimeout no admite más (unos 24 días)
const HOLGURA_VENCIMIENTO_MS = 500; // se vuelve a pedir un instante DESPUÉS de vencer, ya con la ventana cerrada en el servidor

// Las ofertas flash vigentes con lo que queda de cada una EN VIVO. GET /api/productos?soloOfertas=true ya filtra por
// activa + dentro de su ventana de fechas, pero el remanente solo vive en Redis (ofertaFlashService.consultarStock),
// así que se pide aparte, una vez por oferta, después de tener la lista. Con la misma regla que rige la compra: una
// oferta recién agotada, o a la que Redis no puede contestar, desaparece en vez de quedar mostrada sin nada que
// ofrecer (la tienda sigue vendiendo el producto a su precio normal). Catálogo de este tamaño: N llamadas en paralelo
// no son un problema real, y se acotan con `limite`.
//
// Sin Redis el servidor contesta `{ activo: false, motivo: 'no_disponible' }`: no se sabe cuánto queda, no que no haya
// nada. Si NINGUNA oferta pudo leerse se informa como un fallo (la portada dice que no pudo cargarlas, no que no hay);
// si solo algunas, se muestran las que sí.
async function leerOfertas(limite) {
  const productos = await productosApi.listar({ soloOfertas: true });
  const conStock = await Promise.all(
    primerasEnTerminar(productos, limite).map(async (producto) => ({
      producto,
      stock: await ofertasApi.consultarStock(producto.id).catch(() => ({ activo: false, motivo: 'no_disponible' })),
    }))
  );
  if (conStock.length > 0 && conStock.every(({ stock }) => stock.motivo === 'no_disponible')) {
    throw new Error('No pudimos consultar cuántas unidades quedan de cada oferta. Probá de nuevo en unos instantes.');
  }
  return conStock.filter(({ stock }) => stock.activo && stock.restante > 0).map(normalizarOferta);
}

// La lista se mantiene sola, sin recargar la página: cada `cadaMs` mientras la pestaña está a la vista, al volver a ella
// y justo cuando vence la primera oferta («Quedan 3» baja mientras otras personas compran, una oferta nueva aparece y la
// vencida se va). Si una actualización falla se conserva lo que ya se mostraba: el error solo se informa cuando no hay
// nada que mostrar. `actualizar()` repite la lectura a pedido (el botón «Reintentar»).
export function useOfertasFlash({ limite = 24, cadaMs = 30000 } = {}) {
  const [estado, setEstado] = useState({ ofertas: [], cargando: true, error: '', actualizadoEn: 0 });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vigente = true;
    let secuencia = 0;
    let vencimiento = null;

    const cargar = () => {
      const mia = ++secuencia; // una respuesta que llega tarde, con otra ya pedida, se descarta
      return leerOfertas(limite)
        .then((ofertas) => {
          if (!vigente || mia !== secuencia) return;
          setEstado({ ofertas, cargando: false, error: '', actualizadoEn: Date.now() });
          clearTimeout(vencimiento);
          const falta = proximoVencimiento(ofertas);
          if (falta !== null && falta + HOLGURA_VENCIMIENTO_MS < MAXIMO_TEMPORIZADOR) {
            vencimiento = setTimeout(cargar, falta + HOLGURA_VENCIMIENTO_MS);
          }
        })
        .catch((err) => {
          if (!vigente || mia !== secuencia) return;
          setEstado((previo) => ({
            ...previo,
            cargando: false,
            error: previo.ofertas.length > 0 ? '' : err.message || 'No se pudieron cargar las ofertas.',
          }));
        });
    };
    const alVolver = () => {
      if (!document.hidden) cargar();
    };

    cargar();
    const temporizador = setInterval(alVolver, cadaMs);
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      vigente = false;
      clearInterval(temporizador);
      clearTimeout(vencimiento);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [limite, cadaMs, intento]);

  const actualizar = () => {
    setEstado((previo) => ({ ...previo, cargando: true, error: '' }));
    setIntento((n) => n + 1);
  };

  return { ...estado, actualizar };
}
