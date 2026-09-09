const ESTRELLAS = [1, 2, 3, 4, 5];

// Modo lectura (por defecto, sin onChange): muestra `valor` en estrellas
// llenas/vacías — para calificaciones ya guardadas (promedio de un producto,
// o la calificación de una reseña puntual). Modo interactivo (con onChange):
// botones clickeables para elegir 1 a 5 al dejar una reseña.
export function StarRating({ valor = 0, onChange, size = 'text-base' }) {
  const soloLectura = !onChange;

  return (
    <span className={`inline-flex gap-0.5 ${size}`} role={soloLectura ? undefined : 'radiogroup'} aria-label="Calificación en estrellas">
      {ESTRELLAS.map((n) => {
        const llena = n <= Math.round(valor);
        if (soloLectura) {
          return (
            <span key={n} className={llena ? 'text-amber-400' : 'text-neutral-300'}>
              ★
            </span>
          );
        }
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-label={`${n} estrella${n > 1 ? 's' : ''}`}
            aria-pressed={n === valor}
            className={`cursor-pointer transition-transform hover:scale-110 ${llena ? 'text-amber-400' : 'text-neutral-300'}`}
          >
            ★
          </button>
        );
      })}
    </span>
  );
}