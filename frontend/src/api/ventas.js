import { api } from './client';

export const ventasApi = {
  // Envía los filtros y el token del administrador al panel de ventas.
  // Omitir el producto vacío significa consultar todos los productos.
  consultar: (filtros, token) => {
    const params = new URLSearchParams();
    Object.entries(filtros).forEach(([clave, valor]) => {
      if (valor !== '' && valor !== null && valor !== undefined) {
        params.set(clave, String(valor));
      }
    });
    return api.get(`/admin/ventas?${params.toString()}`, token);
  },
};
