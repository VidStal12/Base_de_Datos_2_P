import { useState } from 'react';
import { Field, Input } from '../common/Input';
import { Button } from '../common/Button';

export function NuevaDireccionForm({ onCrear, onCancelar }) {
  const [form, setForm] = useState({ pais: '', direccion: '', codigo_postal: '' });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCrear(form);
      }}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
    >
      <Field label="País">
        <Input required value={form.pais} onChange={(e) => setForm({ ...form, pais: e.target.value })} />
      </Field>
      <Field label="Dirección">
        <Input required value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
      </Field>
      <Field label="Código postal">
        <Input required value={form.codigo_postal} onChange={(e) => setForm({ ...form, codigo_postal: e.target.value })} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1">
          Guardar dirección
        </Button>
        <Button type="button" variant="outline" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
