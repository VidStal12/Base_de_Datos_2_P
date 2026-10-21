import { useState } from 'react';
import { precioDeCubeta } from '../../utils/filtrosBusqueda';

// Enteros sin decimales (Q1,000) y fracciones siempre con dos (Q12.50), como el resto de la tienda.
function quetzales(n) {
  const valor = Number(n);
  const decimales = Number.isInteger(valor) ? 0 : 2;
  return `Q${valor.toLocaleString('es-GT', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })}`;
}

function etiqueta(rango) {
  return rango.hasta === null ? `${quetzales(rango.desde)} o más` : `${quetzales(rango.desde)} – ${quetzales(rango.hasta)}`;
}

// Faceta de precio: el mínimo y el máximo disponibles y cubetas de rango, todo calculado por Elasticsearch
// SIN el filtro de precio ya elegido (para poder ampliarlo). Una cubeta es [desde, hasta): al hacer clic se
// pide precioMax = hasta - 0.01 para que el total coincida con el número que se ve. Quien la monta le pone
// una `key` con el rango vigente: así los campos se reinician cuando el filtro cambia desde otro lado.
export function PriceFacet({ precio, precioMin, precioMax, onAplicar, onQuitar }) {
  const [min, setMin] = useState(precioMin);
  const [max, setMax] = useState(precioMax);
  const activo = precioMin !== '' || precioMax !== '';
  const hayDatos = precio && precio.min !== null && precio.min !== undefined;
  if (!activo && !hayDatos) return null;

  function aplicar(e) {
    e.preventDefault();
    onAplicar(min.trim(), max.trim());
  }

  return (
    <section aria-label="Precio" className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-800">Precio</h2>
        {activo && (
          <button type="button" onClick={onQuitar} className="text-xs font-medium text-brand-700 hover:underline">
            Quitar
          </button>
        )}
      </div>

      {hayDatos && (
        <ul className="mb-3 flex flex-col gap-0.5 text-sm">
          {precio.rangos.map((rango) => {
            const { precioMin: desde, precioMax: hasta } = precioDeCubeta(rango);
            const elegida = precioMin === desde && precioMax === hasta;
            return (
              <li key={rango.desde}>
                <button
                  type="button"
                  onClick={() => onAplicar(desde, hasta)}
                  aria-current={elegida ? 'true' : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-brand-50 ${
                    elegida ? 'font-semibold text-brand-700' : 'text-neutral-700'
                  }`}
                >
                  <span>{etiqueta(rango)}</span>
                  <span className="text-xs font-normal text-neutral-500">{rango.cantidad}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={aplicar} className="flex items-center gap-1.5">
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          aria-label="Precio mínimo"
          placeholder="Mín"
          value={min}
          onChange={(e) => setMin(e.target.value)}
          className="w-full min-w-0 rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
        />
        <span className="text-neutral-400">–</span>
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          aria-label="Precio máximo"
          placeholder="Máx"
          value={max}
          onChange={(e) => setMax(e.target.value)}
          className="w-full min-w-0 rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
          Ir
        </button>
      </form>
      {hayDatos && (
        <p className="mt-1.5 text-xs text-neutral-500">
          Disponible: {quetzales(precio.min)} – {quetzales(precio.max)}
        </p>
      )}
    </section>
  );
}
