// Árbol de categorías de la barra lateral. Sale de `arbol` en la respuesta de GET /api/busqueda
// (agregaciones de Elasticsearch sobre los campos categoria_id/subcategoria_id): cada nodo trae
// cuántos productos tendría al elegirlo con el texto y el precio actuales. Las hermanas de la
// categoría elegida no desaparecen — el árbol no se recorta por la categoría ni por los atributos —
// y los nodos sin resultados se esconden salvo el que está elegido (para poder salir de él).
export function CategoryTree({ arbol, onCategoria, onSubcategoria, onTodas }) {
  const visibles = arbol.filter((c) => c.seleccionada || c.cantidad > 0);
  if (visibles.length === 0) return null;
  const hayElegida = arbol.some((c) => c.seleccionada);

  return (
    <nav aria-label="Categorías" className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-800">Categorías</h2>
        {hayElegida && (
          <button type="button" onClick={onTodas} className="text-xs font-medium text-brand-700 hover:underline">
            Ver todas
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 text-sm">
        {visibles.map((categoria) => {
          const subElegida = categoria.subcategorias.some((s) => s.seleccionada);
          return (
            <li key={categoria.id}>
              <button
                type="button"
                onClick={() => onCategoria(categoria.id)}
                aria-current={categoria.seleccionada && !subElegida ? 'true' : undefined}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-brand-50 ${
                  categoria.seleccionada ? 'font-semibold text-brand-700' : 'text-neutral-800'
                }`}
              >
                <span>{categoria.nombre}</span>
                <span className="text-xs font-normal text-neutral-500">{categoria.cantidad}</span>
              </button>
              {categoria.seleccionada && (
                <ul className="mb-1 ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-neutral-200 pl-2">
                  {categoria.subcategorias
                    .filter((s) => s.seleccionada || s.cantidad > 0)
                    .map((sub) => (
                      <li key={sub.id}>
                        <button
                          type="button"
                          onClick={() => onSubcategoria(sub.id)}
                          aria-current={sub.seleccionada ? 'true' : undefined}
                          className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-brand-50 ${
                            sub.seleccionada ? 'font-semibold text-brand-700' : 'text-neutral-600'
                          }`}
                        >
                          <span>{sub.nombre}</span>
                          <span className="text-xs font-normal text-neutral-500">{sub.cantidad}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
