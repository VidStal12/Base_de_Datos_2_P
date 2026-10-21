import { Button } from '../common/Button';

export function AvisoCheckoutInterrumpido({ onConsultar, consultando, confirmando, mensajeConsulta }) {
  return (
    <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950 lg:col-span-2">
      <h2 className="font-semibold">No pudimos verificar tu compra</h2>
      <p className="mt-2 text-sm">
        Conservamos tu intento de compra. Podés consultar su estado cuando vuelva la conexión.
        Si el pedido ya se confirmó, recuperaremos ese mismo pedido para evitar duplicados.
      </p>
      {mensajeConsulta && <p className="mt-2 text-sm">{mensajeConsulta}</p>}
      <Button variant="outline" className="mt-3" disabled={consultando || confirmando} onClick={onConsultar}>
        {consultando ? 'Consultando...' : 'Consultar estado'}
      </Button>
    </div>
  );
}
