import { useState } from 'react';

const VISIBLES = 8; // valores que se muestran antes de «Ver más»

function Grupo({ atributo, onToggle }) {
  const [todos, setTodos] = useState(false);
  // Un valor elegido se ve siempre, aunque esté más allá de los primeros: si no, no habría cómo desmarcarlo.
  const visibles = todos ? atributo.valores : atributo.valores.filter((v, i) => i < VISIBLES || v.seleccionado);
  const ocultos = atributo.valores.length - visibles.length;

  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">{atributo.nombre}</legend>
      <div className="flex flex-col gap-1">
        {visibles.map((v) => (
          <label key={v.valor} className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={v.seleccionado}
              onChange={() => onToggle(atributo.nombre, v.valor)}
              className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="flex-1">{v.valor}</span>
            <span className="text-xs text-neutral-500">{v.cantidad}</span>
          </label>
        ))}
      </div>
      {(ocultos > 0 || (todos && atributo.valores.length > VISIBLES)) && (
        <button type="button" onClick={() => setTodos((t) => !t)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">
          {todos ? 'Ver menos' : `Ver ${ocultos} más`}
        </button>
      )}
    </fieldset>
  );
}

// Filtros por atributo de la subcategoría elegida. Cada valor trae su conteo, y marcar uno no hace
// desaparecer a sus hermanos: la respuesta cuenta cada atributo con todos los demás filtros menos el suyo
// (facetas disyuntivas), así que se pueden marcar varias tallas a la vez. Entre atributos distintos se
// exigen todos (Talla M y Color Azul); dentro de uno, cualquiera (M o L).
export function AttributeFacets({ atributos, onToggle, onLimpiar }) {
  if (atributos.length === 0) return null;
  const hayElegidos = atributos.some((a) => a.valores.some((v) => v.seleccionado));

  return (
    <section aria-label="Filtros por atributo" className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-800">Filtrar por</h2>
        {hayElegidos && (
          <button type="button" onClick={onLimpiar} className="text-xs font-medium text-brand-700 hover:underline">
            Limpiar
          </button>
        )}
      </div>
      {atributos.map((atributo) => (
        <Grupo key={atributo.nombre} atributo={atributo} onToggle={onToggle} />
      ))}
    </section>
  );
}
