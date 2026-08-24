import { useState } from 'react';
import { Field, Input } from '../common/Input';
import { Button } from '../common/Button';

export function NuevoMetodoPagoForm({ onCrear, onCancelar }) {
  const [form, setForm] = useState({ titular: '', ultimos_4_digitos: '', marca: 'Visa' });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // No se captura ni procesa un número de tarjeta real: eso lo hace la
        // pasarela de pago (ver ADR-001 / ERD, observación 1.4.2). Acá solo se
        // simula el token que esa pasarela devolvería.
        onCrear({ ...form, token_pasarela: `tok_demo_${crypto.randomUUID()}` });
      }}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
    >
      <p className="text-xs text-neutral-500">
        Modo de prueba — no se procesa un pago real ni se guarda un número de tarjeta.
      </p>
      <Field label="Nombre del titular">
        <Input required value={form.titular} onChange={(e) => setForm({ ...form, titular: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Últimos 4 dígitos">
          <Input
            required
            pattern="\d{4}"
            maxLength={4}
            value={form.ultimos_4_digitos}
            onChange={(e) => setForm({ ...form, ultimos_4_digitos: e.target.value })}
          />
        </Field>
        <Field label="Marca">
          <select
            value={form.marca}
            onChange={(e) => setForm({ ...form, marca: e.target.value })}
            className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
          >
            <option>Visa</option>
            <option>Mastercard</option>
            <option>American Express</option>
          </select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1">
          Guardar tarjeta
        </Button>
        <Button type="button" variant="outline" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
