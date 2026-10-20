import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';

// Qué función se limita cuando una base de datos no responde (IA/ENTREGA-3-CONSISTENCIA.md §7).
// El servidor sigue funcionando sin ella; este aviso le dice a la persona qué cambia en vez de
// dejar que lo descubra por un error. `roles`: lo que solo importa a quien tiene esos roles
// (nadie más abre el panel de fraude o de ventas).
const EFECTOS = {
  mysql: 'Las cuentas, el carrito y los pedidos no están disponibles: por ahora no se puede iniciar sesión ni comprar. El catálogo y la búsqueda siguen funcionando.',
  mongo: 'El catálogo se muestra en modo de solo lectura: no hay reseñas ni ofertas flash, y los vendedores no pueden editar sus productos.',
  redis: 'Las ofertas flash y las compras con cupo personal no están disponibles. El resto de la tienda funciona con normalidad.',
  elasticsearch: 'La búsqueda es básica: sigue funcionando, pero sin corrección de errores de tipeo ni autocompletado inteligente.',
  neo4j: { mensaje: 'El panel de fraude no está disponible.', roles: ['administrador'] },
  cassandra: { mensaje: 'El panel de ventas no está disponible.', roles: ['administrador'] },
};

const CADA_MS = 10000;

function mensajesPara(componentes, rol) {
  return Object.entries(componentes)
    .filter(([, estado]) => !estado.ok)
    .map(([nombre]) => EFECTOS[nombre])
    .filter(Boolean)
    .map((efecto) => (typeof efecto === 'string' ? { mensaje: efecto } : efecto))
    .filter((efecto) => !efecto.roles || efecto.roles.includes(rol))
    .map((efecto) => efecto.mensaje);
}

// Consulta qué base responde al cargar, cada 10 s mientras la pestaña esté a la vista y en el
// instante en que vuelve a estarlo. Si ni siquiera el servidor contesta, lo dice también.
export function AvisoServicios() {
  const { usuario } = useAuth();
  const [estado, setEstado] = useState(null);

  useEffect(() => {
    let vigente = true;
    async function consultar() {
      try {
        const respuesta = await api.get('/health/componentes');
        if (vigente) setEstado(respuesta);
      } catch {
        if (vigente) setEstado({ sinConexion: true });
      }
    }
    const siEstaALaVista = () => {
      if (document.visibilityState === 'visible') consultar();
    };
    consultar();
    const id = setInterval(siEstaALaVista, CADA_MS);
    document.addEventListener('visibilitychange', siEstaALaVista);
    return () => {
      vigente = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', siEstaALaVista);
    };
  }, []);

  if (!estado) return null;

  if (estado.sinConexion) {
    return (
      <div role="alert" className="border-b border-danger-500/30 bg-danger-500/10">
        <p className="mx-auto max-w-7xl px-4 py-3 text-sm text-danger-600">
          <strong>No se puede conectar con el servidor.</strong> Probá de nuevo en unos instantes.
        </p>
      </div>
    );
  }

  const mensajes = mensajesPara(estado.componentes ?? {}, usuario?.rol?.tipo_rol);
  if (estado.estado === 'completo' || mensajes.length === 0) return null;

  return (
    <div role="status" className="border-b border-warning-500/30 bg-warning-500/10">
      <div className="mx-auto max-w-7xl px-4 py-3 text-sm text-neutral-800">
        <p className="font-semibold">Algunos servicios no están disponibles en este momento</p>
        <ul className="mt-1 list-disc pl-5">
          {mensajes.map((mensaje) => (
            <li key={mensaje}>{mensaje}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
