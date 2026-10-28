// Marcador de una tarjeta de producto mientras llegan los datos: ocupa el mismo lugar que la tarjeta real, así la
// página no salta cuando se reemplaza. Va oculto a los lectores de pantalla (la sección avisa con aria-busy).
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
