import { useContext } from 'react';
import { diasATexto, formatoQ } from '../../utils/format';
import { BloqueadasContext } from './bloqueadasContext';

// Ficha de usuario — toda la información identificadora que el backend
// resolvió en vivo contra MySQL/Mongo (ver enriquecerUsuarios en
// fraudeService.js). `ficha` puede venir null si el usuario ya no existe
// (poco probable, pero Neo4j no borra en cascada — ver PLAN-NEO4J-
// DETECCION-FRAUDE.md §6); en ese caso solo se muestra lo que ya traía el
// hallazgo (nombre/id cacheados en el grafo).
//
// La usan el panel de fraude y la pantalla de cuentas bloqueadas. Si la cuenta
// está suspendida ahora o bajo vigilancia (BloqueadasContext), lo dice con una insignia.
export function FichaUsuario({ id, nombre, ficha, notasExtra = [] }) {
  const { bloqueadas, restringidas } = useContext(BloqueadasContext);

  if (!ficha) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-500">
        {nombre} <span className="text-neutral-400">#{id}</span>
        <p className="mt-1 text-xs">Cuenta no encontrada en la base actual — puede haber sido eliminada.</p>
      </div>
    );
  }

  const suspendida = ficha.id in bloqueadas;
  const hasta = bloqueadas[ficha.id];
  // Una suspensión ya dice más que los límites suaves: si están las dos, solo se marca la primera.
  const vigilada = !suspendida && ficha.id in restringidas;
  const finDeLimites = restringidas[ficha.id];

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-neutral-900">
          {ficha.nombre} <span className="font-normal text-neutral-400">#{ficha.id}</span>
        </p>
        <div className="flex flex-wrap gap-1">
          {suspendida && (
            <span className="rounded-full bg-danger-500 px-2 py-0.5 text-xs font-medium text-white">
              Suspendida{hasta ? ` hasta ${new Date(hasta).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
            </span>
          )}
          {vigilada && (
            <span className="rounded-full bg-warning-500 px-2 py-0.5 text-xs font-medium text-neutral-900">
              Bajo vigilancia{finDeLimites ? ` hasta ${new Date(finDeLimites).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
            </span>
          )}
          {ficha.cuentaReciente && (
            <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-xs font-medium text-warning-500">
              Cuenta reciente
            </span>
          )}
          {notasExtra.map((nota) => (
            <span key={nota} className="rounded-full bg-danger-500/10 px-2 py-0.5 text-xs font-medium text-danger-600">
              {nota}
            </span>
          ))}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-600">
        <div className="col-span-2">
          <dt className="text-neutral-400">Correo</dt>
          <dd className="truncate">{ficha.correo}</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Rol</dt>
          <dd className="capitalize">{ficha.rol}</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Cuenta creada</dt>
          <dd>
            {new Date(ficha.creadoEn).toLocaleDateString('es-GT', { dateStyle: 'medium' })} · {diasATexto(ficha.diasDesdeCreacion)}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-400">Compras</dt>
          <dd>
            {ficha.totalCompras} ({formatoQ(ficha.totalGastado)})
          </dd>
        </div>
        <div>
          <dt className="text-neutral-400">Compra promedio</dt>
          <dd>{ficha.totalCompras > 0 ? formatoQ(ficha.promedioCompra) : '—'}</dd>
        </div>
        <div>
          <dt className="text-neutral-400">Reseñas</dt>
          <dd>{ficha.totalResenas}</dd>
        </div>
      </dl>
    </div>
  );
}
