import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { direccionesApi, metodosPagoApi } from '../api/cuenta';
import { NuevaDireccionForm } from '../components/account/NuevaDireccionForm';
import { NuevoMetodoPagoForm } from '../components/account/NuevoMetodoPagoForm';
import { Button } from '../components/common/Button';
import { Spinner } from '../components/common/Spinner';

export function AccountPage() {
  const { token } = useAuth();
  const [direcciones, setDirecciones] = useState([]);
  const [metodosPago, setMetodosPago] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [mostrarFormDireccion, setMostrarFormDireccion] = useState(false);
  const [mostrarFormPago, setMostrarFormPago] = useState(false);
  const [errorDireccion, setErrorDireccion] = useState('');
  const [errorPago, setErrorPago] = useState('');
  const [eliminandoDireccion, setEliminandoDireccion] = useState(null);
  const [eliminandoPago, setEliminandoPago] = useState(null);

  useEffect(() => {
    Promise.all([direccionesApi.listar(token), metodosPagoApi.listar(token)])
      .then(([dirs, metodos]) => {
        setDirecciones(dirs);
        setMetodosPago(metodos);
      })
      .finally(() => setCargando(false));
  }, [token]);

  async function crearDireccion(datos) {
    const nueva = await direccionesApi.crear(datos, token);
    setDirecciones((prev) => [...prev, nueva]);
    setMostrarFormDireccion(false);
  }

  async function eliminarDireccion(id) {
    setErrorDireccion('');
    setEliminandoDireccion(id);
    try {
      await direccionesApi.eliminar(id, token);
      setDirecciones((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setErrorDireccion(err.message);
    } finally {
      setEliminandoDireccion(null);
    }
  }

  async function crearMetodoPago(datos) {
    const nuevo = await metodosPagoApi.crear(datos, token);
    setMetodosPago((prev) => [...prev, nuevo]);
    setMostrarFormPago(false);
  }

  async function eliminarMetodoPago(id) {
    setErrorPago('');
    setEliminandoPago(id);
    try {
      await metodosPagoApi.eliminar(id, token);
      setMetodosPago((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setErrorPago(err.message);
    } finally {
      setEliminandoPago(null);
    }
  }

  if (cargando) return <Spinner />;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <h1 className="text-xl font-bold text-neutral-900">Mi cuenta</h1>

      <section className="rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-neutral-900">Direcciones</h2>

        {direcciones.length === 0 && !mostrarFormDireccion && (
          <p className="text-sm text-neutral-500">No tenés direcciones guardadas.</p>
        )}

        <ul className="flex flex-col gap-2">
          {direcciones.map((dir) => (
            <li
              key={dir.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 p-3 text-sm text-neutral-700"
            >
              <span>
                {dir.direccion}, {dir.pais} — {dir.codigo_postal}
              </span>
              <Button
                variant="danger"
                onClick={() => eliminarDireccion(dir.id)}
                disabled={eliminandoDireccion === dir.id}
                className="shrink-0 px-3 py-1.5 text-xs"
              >
                {eliminandoDireccion === dir.id ? 'Eliminando...' : 'Eliminar'}
              </Button>
            </li>
          ))}
        </ul>

        {errorDireccion && <p className="mt-2 text-sm text-danger-600">{errorDireccion}</p>}

        {mostrarFormDireccion ? (
          <div className="mt-3">
            <NuevaDireccionForm onCrear={crearDireccion} onCancelar={() => setMostrarFormDireccion(false)} />
          </div>
        ) : (
          <button
            onClick={() => setMostrarFormDireccion(true)}
            className="mt-3 text-sm font-medium text-brand-700 hover:underline"
          >
            + Agregar dirección
          </button>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-neutral-900">Métodos de pago</h2>

        {metodosPago.length === 0 && !mostrarFormPago && (
          <p className="text-sm text-neutral-500">No tenés métodos de pago guardados.</p>
        )}

        <ul className="flex flex-col gap-2">
          {metodosPago.map((mp) => (
            <li
              key={mp.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 p-3 text-sm text-neutral-700"
            >
              <span>
                {mp.marca} terminada en {mp.ultimos_4_digitos} — {mp.titular}
              </span>
              <Button
                variant="danger"
                onClick={() => eliminarMetodoPago(mp.id)}
                disabled={eliminandoPago === mp.id}
                className="shrink-0 px-3 py-1.5 text-xs"
              >
                {eliminandoPago === mp.id ? 'Eliminando...' : 'Eliminar'}
              </Button>
            </li>
          ))}
        </ul>

        {errorPago && <p className="mt-2 text-sm text-danger-600">{errorPago}</p>}

        {mostrarFormPago ? (
          <div className="mt-3">
            <NuevoMetodoPagoForm onCrear={crearMetodoPago} onCancelar={() => setMostrarFormPago(false)} />
          </div>
        ) : (
          <button onClick={() => setMostrarFormPago(true)} className="mt-3 text-sm font-medium text-brand-700 hover:underline">
            + Agregar método de pago
          </button>
        )}
      </section>
    </div>
  );
}
