// Migas de pan: salen de `ruta` en la respuesta de GET /api/busqueda (la categoría y la subcategoría
// elegidas, con sus nombres, también cuando solo llegó un id desde el menú). Cada miga lleva un nivel
// más arriba; la última es donde ya se está.
export function Migas({ ruta, onTodas, onCategoria }) {
  if (ruta.length === 0) return null;
  const boton = 'font-medium text-brand-700 hover:underline';
  return (
    <nav aria-label="Ubicación" className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-500">
      <button type="button" onClick={onTodas} className={boton}>
        Todos
      </button>
      {ruta.map((miga, i) => {
        const ultima = i === ruta.length - 1;
        return (
          <span key={`${miga.tipo}-${miga.id}`} className="flex items-center gap-1.5">
            <span aria-hidden="true">›</span>
            {ultima ? (
              <span aria-current="page" className="font-semibold text-neutral-800">
                {miga.nombre}
              </span>
            ) : (
              <button type="button" onClick={() => onCategoria(miga.id)} className={boton}>
                {miga.nombre}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
