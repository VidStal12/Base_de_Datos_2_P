// Marcadores mientras llegan los datos: ocupan el mismo lugar que lo real, así la página no salta cuando se reemplazan.
// Van ocultos a los lectores de pantalla (la sección avisa con aria-busy).

// Una fila de la lista «Mis productos» del vendedor: imagen, dos líneas de texto y los botones.
export function FilaEsqueleto() {
  return (
    <div aria-hidden="true" className="flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4 motion-safe:animate-pulse">
      <div className="size-16 shrink-0 rounded-lg bg-neutral-200" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="h-3.5 w-2/5 rounded bg-neutral-200" />
        <div className="h-3 w-1/4 rounded bg-neutral-200" />
      </div>
      <div className="hidden h-9 w-24 rounded-lg bg-neutral-200 sm:block" />
      <div className="h-9 w-20 rounded-lg bg-neutral-200" />
    </div>
  );
}

// Una tarjeta de producto de la tienda.
export function TarjetaEsqueleto() {
  return (
    <div aria-hidden="true" className="flex h-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white motion-safe:animate-pulse">
      <div className="aspect-square bg-neutral-200" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-3 w-5/6 rounded bg-neutral-200" />
        <div className="h-3 w-2/3 rounded bg-neutral-200" />
        <div className="mt-2 h-5 w-1/3 rounded bg-neutral-200" />
      </div>
    </div>
  );
}
