import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Field, Input } from '../components/common/Input';
import { Button } from '../components/common/Button';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next') || '/';

  const [correo, setCorreo] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setEnviando(true);
    try {
      await login(correo, contrasena);
      navigate(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 rounded-xl border border-neutral-200 bg-white p-8">
      <h1 className="text-center text-xl font-bold text-neutral-900">Iniciar sesión</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Correo">
          <Input type="email" required value={correo} onChange={(e) => setCorreo(e.target.value)} />
        </Field>
        <Field label="Contraseña">
          <Input type="password" required value={contrasena} onChange={(e) => setContrasena(e.target.value)} />
        </Field>

        {error && <p className="text-sm text-danger-600">{error}</p>}

        <Button type="submit" variant="primary" disabled={enviando} className="py-3">
          {enviando ? 'Ingresando...' : 'Iniciar sesión'}
        </Button>
      </form>

      <p className="text-center text-sm text-neutral-600">
        ¿No tenés cuenta?{' '}
        <Link to="/registro" className="font-medium text-brand-700 hover:underline">
          Registrate
        </Link>
      </p>
    </div>
  );
}
