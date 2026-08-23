import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Field, Input } from '../components/common/Input';
import { Button } from '../components/common/Button';

export function RegisterPage() {
  const { registrar } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    nombres: '',
    apellidos: '',
    correo: '',
    contrasena: '',
    fecha_nacimiento: '',
  });
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  function actualizar(campo, valor) {
    setForm((prev) => ({ ...prev, [campo]: valor }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setEnviando(true);
    try {
      await registrar(form);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 rounded-xl border border-neutral-200 bg-white p-8">
      <h1 className="text-center text-xl font-bold text-neutral-900">Crear cuenta</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombres">
            <Input required value={form.nombres} onChange={(e) => actualizar('nombres', e.target.value)} />
          </Field>
          <Field label="Apellidos">
            <Input required value={form.apellidos} onChange={(e) => actualizar('apellidos', e.target.value)} />
          </Field>
        </div>
        <Field label="Correo">
          <Input type="email" required value={form.correo} onChange={(e) => actualizar('correo', e.target.value)} />
        </Field>
        <Field label="Contraseña" error="Mínimo 8 caracteres">
          <Input
            type="password"
            required
            minLength={8}
            value={form.contrasena}
            onChange={(e) => actualizar('contrasena', e.target.value)}
          />
        </Field>
        <Field label="Fecha de nacimiento">
          <Input
            type="date"
            required
            value={form.fecha_nacimiento}
            onChange={(e) => actualizar('fecha_nacimiento', e.target.value)}
          />
        </Field>

        {error && <p className="text-sm text-danger-600">{error}</p>}

        <Button type="submit" variant="primary" disabled={enviando} className="py-3">
          {enviando ? 'Creando cuenta...' : 'Crear cuenta'}
        </Button>
      </form>

      <p className="text-center text-sm text-neutral-600">
        ¿Ya tenés cuenta?{' '}
        <Link to="/login" className="font-medium text-brand-700 hover:underline">
          Iniciá sesión
        </Link>
      </p>
    </div>
  );
}
