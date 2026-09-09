import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { fraudeApi } from '../../api/fraude';
import { Spinner } from '../../components/common/Spinner';

// Señales de posible fraude (Neo4j, ver IA/PLAN-NEO4J-DETECCION-FRAUDE.md) —
// lista simple, no un dashboard con gráficas (a diferencia de
// AdminVentasPage.jsx): el resultado de estas dos consultas es "pares/
// patrones candidatos", no una serie de tiempo. Nunca una acusación —
// candidatos para revisión humana, se dice explícito en la UI, no solo en el
// documento de diseño.
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
              Candidatos para revisión humana — ninguna fila de acá es una acusación por sí sola.
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
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                      <th className="py-2 pr-4">Cuenta 1</th>
                      <th className="py-2 pr-4">Cuenta 2</th>
                      <th className="py-2 pr-4">Productos compartidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datos.resenasCoordinadas.map((r, i) => (
                      <tr key={i} className="border-b border-neutral-100 last:border-0">
                        <td className="py-2 pr-4">{r.usuario1.nombre} <span className="text-neutral-400">#{r.usuario1.id}</span></td>
                        <td className="py-2 pr-4">{r.usuario2.nombre} <span className="text-neutral-400">#{r.usuario2.id}</span></td>
                        <td className="py-2 pr-4">
                          {r.productosCompartidos} — <span className="text-neutral-500">{r.productos.join(', ')}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                      <th className="py-2 pr-4">Cuenta</th>
                      <th className="py-2 pr-4">Producto</th>
                      <th className="py-2 pr-4">Comparte dirección con</th>
                      <th className="py-2 pr-4">Fecha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datos.desviacionPatron.map((d, i) => (
                      <tr key={i} className="border-b border-neutral-100 last:border-0">
                        <td className="py-2 pr-4">{d.usuario.nombre} <span className="text-neutral-400">#{d.usuario.id}</span></td>
                        <td className="py-2 pr-4">{d.producto.descripcion}</td>
                        <td className="py-2 pr-4">{d.otraCuenta.nombre} <span className="text-neutral-400">#{d.otraCuenta.id}</span></td>
                        <td className="py-2 pr-4 text-neutral-500">{d.fecha ? new Date(d.fecha).toLocaleString('es-GT') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
