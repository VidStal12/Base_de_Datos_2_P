import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fraudeApi } from '../../api/fraude';
import { Spinner } from '../../components/common/Spinner';

function diasATexto(dias) {
  if (dias < 1) return 'hoy';
  if (dias === 1) return 'hace 1 día';
  return `hace ${dias} días`;
}

// Ficha de usuario — toda la información identificadora que el backend
// resolvió en vivo contra MySQL/Mongo (ver enriquecerUsuarios en
// fraudeService.js). `ficha` puede venir null si el usuario ya no existe
// (poco probable, pero Neo4j no borra en cascada — ver PLAN-NEO4J-
// DETECCION-FRAUDE.md §6); en ese caso solo se muestra lo que ya traía el
// hallazgo (nombre/id cacheados en el grafo).
function FichaUsuario({ id, nombre, ficha, notaExtra }) {
  if (!ficha) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-500">
        {nombre} <span className="text-neutral-400">#{id}</span>
        <p className="mt-1 text-xs">Cuenta no encontrada en la base actual — puede haber sido eliminada.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-neutral-900">
          {ficha.nombre} <span className="font-normal text-neutral-400">#{ficha.id}</span>
        </p>
        <div className="flex flex-wrap gap-1">
          {ficha.cuentaReciente && (
            <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-700">
              Cuenta reciente
            </span>
          )}
          {notaExtra && (
            <span className="rounded-full bg-danger-500/10 px-2 py-0.5 text-xs font-medium text-danger-600">{notaExtra}</span>
          )}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-600">
        <div>
          <dt className="text-neutral-400">Correo</dt>
          <dd className="truncate">{ficha.correo}</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Rol</dt>
          <dd className="capitalize">{ficha.rol}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-neutral-400">Cuenta creada</dt>
          <dd>
            {new Date(ficha.creadoEn).toLocaleDateString('es-GT', { dateStyle: 'medium' })} · {diasATexto(ficha.diasDesdeCreacion)}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-400">Compras</dt>
          <dd>{ficha.totalCompras} (Q{ficha.totalGastado.toFixed(2)})</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Reseñas</dt>
          <dd>{ficha.totalResenas}</dd>
        </div>
      </dl>

      {ficha.direcciones.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="text-neutral-400">Direcciones</p>
          <ul className="mt-0.5 list-inside list-disc text-neutral-600">
            {ficha.direcciones.map((d, i) => (
              <li key={i}>
                {d.direccion}, {d.pais} ({d.codigoPostal})
              </li>
            ))}
          </ul>
        </div>
      )}

      {ficha.metodosPago.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="text-neutral-400">Métodos de pago</p>
          <ul className="mt-0.5 list-inside list-disc text-neutral-600">
            {ficha.metodosPago.map((m, i) => (
              <li key={i}>{m.marca} •••• {m.ultimos4}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Señales de posible fraude (Neo4j, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) —
// cada hallazgo se muestra como un mini-reporte: el motivo en prosa (armado
// en el backend, junto a la consulta que lo produce) más una ficha por
// cuenta involucrada. Nunca una acusación — candidatos para revisión
// humana, se dice explícito en la UI, no solo en el documento de diseño.
export function AdminFraudePage() {
  const { token } = useAuth();
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  function cargar() {
    setCargando(true);
    setError('');
    fraudeApi
      .consultar(token)
      .then(setDatos)
      .catch((err) => setError(err.message))
      .finally(() => setCargando(false));
  }

  useEffect(cargar, [token]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/admin" className="text-sm font-medium text-brand-700 hover:underline">
          ← Panel de administrador
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-neutral-900">Señales de fraude</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Candidatos para revisión humana — ninguna tarjeta de acá es una acusación por sí sola.
            </p>
          </div>
          <button onClick={cargar} className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            Actualizar
          </button>
        </div>
      </div>

      {cargando && <Spinner />}
      {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

      {datos && (
        <>
          {datos.advertencias?.length > 0 && (
            <div className="rounded-lg bg-warning-500/10 p-3 text-sm text-warning-700">
              {datos.advertencias.map((a, i) => (
                <p key={i}>{a}</p>
              ))}
            </div>
          )}

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-800">Reseñas coordinadas</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Cuentas distintas que reseñaron los mismos productos, calificación alta, dentro de una ventana de tiempo corta.
            </p>
            {datos.resenasCoordinadas.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">Sin patrones señalados por ahora.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {datos.resenasCoordinadas.map((r, i) => (
                  <div key={i} className="rounded-lg border border-warning-500/30 bg-warning-500/5 p-3">
                    <p className="text-sm text-neutral-800">{r.motivo}</p>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FichaUsuario id={r.usuario1.id} nombre={r.usuario1.nombre} ficha={r.usuario1.ficha} />
                      <FichaUsuario id={r.usuario2.id} nombre={r.usuario2.nombre} ficha={r.usuario2.ficha} />
                    </div>
                    {r.ultimaActividad && (
                      <p className="mt-2 text-xs text-neutral-400">
                        Última reseña del grupo: {new Date(r.ultimaActividad).toLocaleString('es-GT')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-800">Desviación de patrón de compra</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Una compra en una categoría nueva para esa cuenta, enviada a una dirección que otra cuenta distinta también usó.
            </p>
            {datos.desviacionPatron.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">Sin patrones señalados por ahora.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {datos.desviacionPatron.map((d, i) => {
                  const confianzaAlta = d.nivelConfianza === 'alta';
                  return (
                    <div
                      key={i}
                      className={`rounded-lg border p-3 ${
                        confianzaAlta ? 'border-danger-500/30 bg-danger-500/5' : 'border-neutral-200 bg-neutral-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
                            confianzaAlta ? 'bg-danger-600 text-white' : 'bg-neutral-200 text-neutral-600'
                          }`}
                        >
                          {confianzaAlta ? 'Confianza alta' : 'Posible coincidencia'}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-neutral-800">{d.motivo}</p>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <FichaUsuario id={d.usuario.id} nombre={d.usuario.nombre} ficha={d.usuario.ficha} />
                        {d.otrasCuentas.map((o) => (
                          <FichaUsuario
                            key={o.id}
                            id={o.id}
                            nombre={o.nombre}
                            ficha={o.ficha}
                            notaExtra={o.mismoMetodoPago ? 'Mismo método de pago' : undefined}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-neutral-400">
                        Producto: {d.producto.descripcion} · Categoría: {d.subcategoria} · Monto: Q{d.monto.toFixed(2)} ·{' '}
                        {d.fecha ? new Date(d.fecha).toLocaleString('es-GT') : 'fecha desconocida'}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
