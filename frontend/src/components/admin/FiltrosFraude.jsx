import { NIVELES, TIPOS, VINCULOS, hayFiltros } from '../../utils/fraudeCasos';

// Barra de filtros del panel de señales de fraude (pages/admin/AdminFraudePage.jsx): cuenta, probabilidad, relación y
// vínculo. Todo se filtra en el navegador sobre lo que ya llegó (la lista completa son decenas de casos), así que cada
// cambio es instantáneo. Cada opción dice cuántos casos habría al elegirla CON los demás filtros puestos
// (utils/fraudeCasos.conteos): una opción sin casos queda desactivada, así nadie llega a una pantalla vacía sin saber por qué.

const controlClase =
  'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-brand-500 focus:outline-brand-500';

function Campo({ etiqueta, htmlFor, clase = '', children }) {
  return (
    <label htmlFor={htmlFor} className={`flex min-w-0 flex-col gap-1.5 text-sm font-medium text-neutral-700 ${clase}`}>
      {etiqueta}
      {children}
    </label>
  );
}

// «Todas (9)», «Autocompra (3)». La opción elegida nunca se desactiva, aunque con los otros filtros ya no tenga casos:
// si no, no habría cómo ver que está puesta ni cómo quitarla.
function Selector({ id, valor, onCambio, opciones, cuenta, todas }) {
  return (
    <select id={id} className={controlClase} value={valor} onChange={(evento) => onCambio(evento.target.value)}>
      <option value="">
        {todas} ({cuenta.todas})
      </option>
      {opciones.map((opcion) => {
        const n = cuenta[opcion.id] ?? 0;
        return (
          <option key={opcion.id} value={opcion.id} disabled={n === 0 && opcion.id !== valor}>
            {opcion.texto ?? opcion.titulo} ({n})
          </option>
        );
      })}
    </select>
  );
}

export function FiltrosFraude({ filtros, usuarioEscrito, cuentas, onUsuario, onNivel, onRelacion, onVinculo, onLimpiar }) {
  const activos = hayFiltros({ ...filtros, usuario: usuarioEscrito });

  return (
    <section aria-label="Filtros de los casos" className="rounded-xl border border-neutral-200 bg-white p-4">
      {/* En el celular: la cuenta ocupa el ancho, probabilidad y vínculo van lado a lado y la relación (la de textos más
          largos) otra vez a todo el ancho; el orden del teclado sigue siendo cuenta, probabilidad, relación, vínculo. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <Campo etiqueta="Cuenta" htmlFor="filtro-usuario" clase="col-span-2 lg:col-span-1">
          <input
            id="filtro-usuario"
            type="search"
            value={usuarioEscrito}
            onChange={(evento) => onUsuario(evento.target.value)}
            placeholder="Nombre, correo o #id"
            autoComplete="off"
            className={controlClase}
          />
        </Campo>
        <Campo etiqueta="Probabilidad" htmlFor="filtro-nivel">
          <Selector id="filtro-nivel" valor={filtros.nivel} onCambio={onNivel} opciones={NIVELES} cuenta={cuentas.nivel} todas="Todas" />
        </Campo>
        <Campo etiqueta="Relación" htmlFor="filtro-relacion" clase="order-last col-span-2 lg:order-none lg:col-span-1">
          <Selector id="filtro-relacion" valor={filtros.relacion} onCambio={onRelacion} opciones={TIPOS} cuenta={cuentas.relacion} todas="Todas" />
        </Campo>
        <Campo etiqueta="Vínculo entre cuentas" htmlFor="filtro-vinculo">
          <Selector id="filtro-vinculo" valor={filtros.vinculo} onCambio={onVinculo} opciones={VINCULOS} cuenta={cuentas.vinculo} todas="Todos" />
        </Campo>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <p role="status" aria-live="polite" className="text-neutral-600">
          {activos ? (
            <>
              Mostrando <strong className="text-neutral-900">{cuentas.visibles}</strong> de {cuentas.total} casos
            </>
          ) : (
            <>
              <strong className="text-neutral-900">{cuentas.total}</strong> {cuentas.total === 1 ? 'caso' : 'casos'} en total
            </>
          )}
        </p>
        {activos && (
          <button type="button" onClick={onLimpiar} className="font-medium text-brand-700 hover:underline">
            Limpiar filtros
          </button>
        )}
      </div>
    </section>
  );
}
