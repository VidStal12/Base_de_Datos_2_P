import { Link } from 'react-router-dom';
import { Button } from '../common/Button';

export function EstadoIntento({ intento, procesando, onNuevo, error }) {
  return <div className="rounded-xl border border-neutral-200 p-5">
    <p>{intento.estado === 'completado' ? 'Esta compra ya fue confirmada.' : 'La compra no se completó. Podés revisar los datos y preparar otra.'}</p>
    {intento.compraId && <Link className="mt-3 block text-brand-700 underline" to={`/pedidos/${intento.compraId}`}>Ver pedido</Link>}
    {error && <p role="alert" className="mt-3 text-danger-600">{error}</p>}
    <Button disabled={procesando} onClick={onNuevo} className="mt-4">{procesando ? 'Preparando...' : 'Preparar una nueva compra'}</Button>
  </div>;
}
