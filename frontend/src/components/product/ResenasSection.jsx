import { useEffect, useState } from 'react';
import { resenasApi } from '../../api/resenas';
import { StarRating } from '../common/StarRating';
import { Button } from '../common/Button';

// Reseñas por producto (reference, ver ADR-002 §6.1 y backend/Resena.js) —
// lista pública, formulario para dejar una nueva solo con sesión iniciada
// (cualquier rol, no solo comprador — mismo criterio que el backend).
export function ResenasSection({ productoId, token, estaAutenticado }) {
  const [resenas, setResenas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [calificacion, setCalificacion] = useState(0);
  const [comentario, setComentario] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');

  function cargar() {
    setCargando(true);
    resenasApi
      .listar(productoId)
      .then(setResenas)
      .catch(() => setResenas([]))
      .finally(() => setCargando(false));
  }

  useEffect(cargar, [productoId]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (calificacion < 1) {
      setError('Elegí una calificación de 1 a 5 estrellas.');
      return;
    }
    setEnviando(true);
    setError('');
    try {
      await resenasApi.crear(productoId, { calificacion, comentario }, token);
      setCalificacion(0);
      setComentario('');
      cargar();
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  }

  if (cargando) return null;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6">
      <h2 className="mb-4 text-lg font-bold text-neutral-900">
        Reseñas {resenas.length > 0 && `(${resenas.length})`}
      </h2>

      {resenas.length === 0 && <p className="text-sm text-neutral-500">Todavía no hay reseñas para este producto.</p>}

      <ul className="flex flex-col gap-4">
        {resenas.map((r) => (
          <li key={r.id} className="border-b border-neutral-100 pb-4 last:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <StarRating valor={r.calificacion} />
              <span className="text-sm font-medium text-neutral-800">{r.usuario_nombre}</span>
              <span className="text-xs text-neutral-400">
                {new Date(r.fecha).toLocaleDateString('es-GT', { dateStyle: 'medium' })}
              </span>
            </div>
            {r.comentario && <p className="mt-1 text-sm text-neutral-600">{r.comentario}</p>}
          </li>
        ))}
      </ul>

      <div className="mt-6 border-t border-neutral-100 pt-4">
        {estaAutenticado ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-neutral-800">Dejar una reseña</h3>
            <StarRating valor={calificacion} onChange={setCalificacion} size="text-2xl" />
            <textarea
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
              placeholder="Contanos qué te pareció (opcional)"
              rows={3}
              maxLength={1000}
              className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            {error && <p className="text-sm text-danger-600">{error}</p>}
            <Button type="submit" variant="accent" disabled={enviando} className="self-start">
              {enviando ? 'Enviando...' : 'Publicar reseña'}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-neutral-500">Iniciá sesión para dejar una reseña.</p>
        )}
      </div>
    </div>
  );
}