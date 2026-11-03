import { resaltar } from '../../utils/productosVendedor';

// El texto con las palabras buscadas marcadas (utils/productosVendedor.js → resaltar). <mark> es el elemento semántico
// para esto: los lectores de pantalla lo anuncian como «resaltado». Sin búsqueda, el texto tal cual.
export function Resaltado({ texto, tokens }) {
  const tramos = resaltar(texto, tokens);
  if (tramos.length === 1 && !tramos[0].resaltado) return <>{tramos[0].texto}</>;
  return (
    <>
      {tramos.map((tramo, i) =>
        tramo.resaltado ? (
          <mark key={i} className="rounded-sm bg-warning-500/30 px-0.5 text-inherit">
            {tramo.texto}
          </mark>
        ) : (
          <span key={i}>{tramo.texto}</span>
        )
      )}
    </>
  );
}
