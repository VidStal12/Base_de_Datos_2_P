import { useState } from 'react';
import { Button } from '../common/Button';
import { IconoBuscar, IconoCerrar, IconoChevronDer } from '../common/iconos';
import { ESTADOS, NIVELES_STOCK, ORDENES, agruparPorCategoria, hayFiltros, ordenEfectivo } from '../../utils/productosVendedor';

const CAMPO = 'w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

// Un <select> con su etiqueta (solo para lectores de pantalla: la primera opción dice qué es). Cuando tiene un valor
// elegido se tiñe de azul, así se ve de un vistazo qué está filtrando la lista.
function Selector({ id, etiqueta, valor, onCambiar, elegido, className = '', children }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">
        {etiqueta}
      </label>
      <select
        id={id}
        value={valor}
        onChange={(e) => onCambiar(e.target.value)}
        className={`${CAMPO} ${elegido ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-neutral-300 bg-white text-neutral-800'}`}
      >
        {children}
      </select>
    </div>
  );
}

// El encabezado de «Mis productos» (patrón de los paneles de vendedor): búsqueda, pestañas de estado con su conteo, filtros
// de categoría y stock, orden, y los filtros activos como fichas que se quitan de a uno. Los conteos son disyuntivos
// (utils/productosVendedor.js → facetas): cada opción cuenta con los demás filtros aplicados, así «Inactivos 3» sigue
// diciendo cuántos hay aunque estén marcados los «Activos». Todo lo que se elige lo controla la pantalla; lo único que se
// guarda acá es si, en un teléfono, el panel de categoría, stock y orden está desplegado (en pantallas grandes siempre lo está).
export function BarraProductos({ inputRef, texto, onTexto, onEnviar, onBorrarTexto, filtros, conteos, onEstado, onSubcategoria, onStock, onOrden, onLimpiar }) {
  const [desplegado, setDesplegado] = useState(false);
  const hayTexto = Boolean(filtros.q);
  const porDefecto = ordenEfectivo('', hayTexto);
  const grupos = agruparPorCategoria(conteos.subcategorias);
  const subElegida = conteos.subcategorias.find((s) => s.id === filtros.sub);
  const fichas = [
    filtros.estado && { clave: 'estado', texto: `Estado: ${ESTADOS.find((e) => e.valor === filtros.estado)?.texto}`, quitar: () => onEstado('') },
    subElegida && { clave: 'sub', texto: `Categoría: ${subElegida.nombre}`, quitar: () => onSubcategoria('') },
    filtros.stock && { clave: 'stock', texto: `Stock: ${NIVELES_STOCK.find((n) => n.valor === filtros.stock)?.texto}`, quitar: () => onStock('') },
  ].filter(Boolean);
  // Lo que cambió el panel plegable respecto de su estado inicial: es el número que lleva el botón en un teléfono.
  const ajustes = fichas.length + (filtros.orden ? 1 : 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3 sm:p-4">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onEnviar();
        }}
        className="relative"
      >
        <label htmlFor="buscar-mis-productos" className="sr-only">
          Buscar en mis productos
        </label>
        <IconoBuscar className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-neutral-400" />
        <input
          id="buscar-mis-productos"
          ref={inputRef}
          type="search"
          value={texto}
          onChange={(e) => onTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            if (texto) onBorrarTexto();
            else e.currentTarget.blur();
          }}
          placeholder="Buscar por nombre, #ID, categoría o atributo…"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={120}
          className="w-full rounded-lg border border-neutral-300 bg-white py-2.5 pl-10 pr-11 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {texto ? (
          <button
            type="button"
            onClick={onBorrarTexto}
            aria-label="Borrar la búsqueda"
            className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            <IconoCerrar className="size-4" />
          </button>
        ) : (
          <kbd
            aria-hidden="true"
            title="Atajo: pulsá / para buscar"
            className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-neutral-300 bg-neutral-50 px-1.5 text-xs text-neutral-500 sm:inline-block"
          >
            /
          </kbd>
        )}
      </form>

      <div role="group" aria-label="Filtrar por estado" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
        {ESTADOS.map(({ valor, texto: etiqueta }) => {
          const activo = filtros.estado === valor;
          return (
            <button
              key={valor || 'todos'}
              type="button"
              aria-pressed={activo}
              onClick={() => onEstado(valor)}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
                activo ? 'border-brand-600 bg-brand-600 text-white' : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50'
              }`}
            >
              {etiqueta} <span className={`tabular-nums ${activo ? 'text-white/80' : 'text-neutral-500'}`}>{conteos.estados[valor || 'total']}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setDesplegado(!desplegado)}
        aria-expanded={desplegado}
        aria-controls="filtros-productos"
        className="flex items-center justify-between rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 sm:hidden"
      >
        <span>
          Filtros y orden
          {ajustes > 0 && <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">{ajustes}</span>}
        </span>
        <IconoChevronDer className={`size-4 transition-transform ${desplegado ? '-rotate-90' : 'rotate-90'}`} />
      </button>

      <div id="filtros-productos" className={`${desplegado ? 'grid' : 'hidden'} grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center`}>
        <Selector id="filtro-categoria" etiqueta="Categoría" valor={subElegida ? filtros.sub : ''} onCambiar={onSubcategoria} elegido={Boolean(subElegida)} className="sm:w-56">
          <option value="">Todas las categorías</option>
          {grupos.map((grupo) => (
            <optgroup key={grupo.categoria} label={grupo.categoria}>
              {grupo.subs.map((sub) => (
                <option key={sub.id} value={sub.id}>
                  {sub.nombre} ({sub.cantidad})
                </option>
              ))}
            </optgroup>
          ))}
        </Selector>

        <Selector id="filtro-stock" etiqueta="Stock" valor={filtros.stock} onCambiar={onStock} elegido={Boolean(filtros.stock)} className="sm:w-48">
          {NIVELES_STOCK.map(({ valor, texto: etiqueta }) => (
            <option key={valor || 'todo'} value={valor}>
              {valor ? `${etiqueta} (${conteos.stock[valor]})` : etiqueta}
            </option>
          ))}
        </Selector>

        <label className="flex items-center gap-2 text-sm text-neutral-600 sm:ml-auto">
          <span className="shrink-0">Ordenar por</span>
          <select
            value={ordenEfectivo(filtros.orden, hayTexto)}
            onChange={(e) => onOrden(e.target.value === porDefecto ? '' : e.target.value)}
            className={`${CAMPO} border-neutral-300 bg-white text-neutral-800 sm:w-52`}
          >
            {ORDENES.filter((o) => o.valor !== 'relevancia' || hayTexto).map(({ valor, texto: etiqueta }) => (
              <option key={valor} value={valor}>
                {etiqueta}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(fichas.length > 0 || hayFiltros(filtros)) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3">
          {fichas.map((ficha) => (
            <button
              key={ficha.clave}
              type="button"
              onClick={ficha.quitar}
              aria-label={`Quitar el filtro ${ficha.texto}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 py-1 pl-3 pr-2 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
            >
              {ficha.texto}
              <IconoCerrar className="size-3.5" />
            </button>
          ))}
          <Button variant="ghost" onClick={onLimpiar} className="px-2! py-1! text-xs!">
            Limpiar filtros
          </Button>
        </div>
      )}
    </div>
  );
}
