import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { permisosApi } from '../../api/permisos';
import { Spinner } from '../../components/common/Spinner';
import { Toast } from '../../components/common/Toast';
import { Button } from '../../components/common/Button';
import { MatrizPermisos } from '../../components/admin/permisos/MatrizPermisos';
import { SimuladorPermisos } from '../../components/admin/permisos/SimuladorPermisos';
import { CuentasYRoles } from '../../components/admin/permisos/CuentasYRoles';
import { AuditoriaAcceso } from '../../components/admin/permisos/AuditoriaAcceso';

const SECCIONES = [
  { id: 'permisos', texto: 'Permisos' },
  { id: 'simulador', texto: 'Simulador' },
  { id: 'cuentas', texto: 'Cuentas y roles' },
  { id: 'auditoria', texto: 'Auditoría' },
];

// La pantalla de permisos (IA/ADR-007 §9): el administrador ajusta qué roles usan qué acciones del panel, crea roles,
// asigna roles a las cuentas, prueba una decisión antes de guardarla y revisa quién cambió qué. La base de todo es la
// lista blanca del código (config/politicaRutas.js); acá solo se guardan las diferencias. Es la referencia de las
// consolas de permisos reales: una matriz rol × acción (GitHub, Auth0), un simulador (AWS IAM, kubectl auth can-i) y
// un registro filtrable y exportable (GitHub).
export function AdminPermisosPage() {
  const { token } = useAuth();
  const [parametros, setParametros] = useSearchParams();
  const seccion = SECCIONES.some((s) => s.id === parametros.get('seccion')) ? parametros.get('seccion') : 'permisos';
  const [matriz, setMatriz] = useState(null);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [filtro, setFiltro] = useState('');
  const [version, setVersion] = useState(0); // sube con cada cambio: las listas que dependen de él se vuelven a pedir

  const cargar = useCallback(async () => {
    try {
      setMatriz(await permisosApi.matriz(token));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useEffect(() => {
    let vigente = true;
    permisosApi
      .matriz(token)
      .then((m) => vigente && setMatriz(m))
      .catch((err) => vigente && setError(err.message));
    return () => {
      vigente = false;
    };
  }, [token]);

  // Después de un cambio: se vuelve a leer la matriz (lo que rige AHORA, no lo que se creyó haber guardado) y se avisa.
  const alCambiar = useCallback(
    async (mensaje) => {
      await cargar();
      setVersion((v) => v + 1);
      if (mensaje) setAviso(mensaje);
    },
    [cargar]
  );

  const irA = (id) => setParametros(id === 'permisos' ? {} : { seccion: id }, { replace: false });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Permisos y accesos</h1>
          <p className="text-sm text-neutral-500">
            <Link to="/admin" className="text-brand-700 hover:underline">
              Panel
            </Link>{' '}
            · Solo un administrador entra acá, y esto no se le puede conceder a ningún otro rol.
          </p>
        </div>
        {matriz && (
          <p className="text-sm text-neutral-600">
            {matriz.roles.length} roles · {matriz.rutas.filter((r) => r.editable).length} acciones que se pueden ajustar ·{' '}
            <strong>{matriz.reglas}</strong> {matriz.reglas === 1 ? 'regla cambiada' : 'reglas cambiadas'}
          </p>
        )}
      </div>

      <details className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
        <summary className="cursor-pointer font-medium text-neutral-900">Cómo funciona</summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>
            <strong>Lista blanca:</strong> el código declara, ruta por ruta, qué roles entran; lo que no figura se niega. Una ruta nueva sin declarar hace
            fallar las pruebas.
          </li>
          <li>
            <strong>Solo diferencias:</strong> esta pantalla guarda lo que un administrador cambió respecto del código. «Restaurar» borra esas diferencias.
          </li>
          <li>
            <strong>Lo que no se puede cambiar:</strong> la columna del administrador (conserva todo, así nadie se queda sin acceso), las rutas que dependen del
            dueño del producto o del compromiso de no reventa, y las de esta misma pantalla.
          </li>
          <li>
            <strong>Rige en segundos:</strong> la API decide con el rol de hoy de cada cuenta y con la política vigente, no con lo que dice el token.
          </li>
          <li>
            <strong>Todo queda registrado</strong> en una colección de MongoDB que el servidor solo puede leer e insertar.
          </li>
        </ul>
      </details>

      <div role="tablist" aria-label="Secciones" className="flex flex-wrap gap-1 border-b border-neutral-200">
        {SECCIONES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`pestana-${s.id}`}
            aria-selected={seccion === s.id}
            aria-controls={`panel-${s.id}`}
            onClick={() => irA(s.id)}
            className={`-mb-px rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium transition-colors ${
              seccion === s.id ? 'border-neutral-200 bg-white text-brand-700' : 'border-transparent text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {s.texto}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${seccion}`} aria-labelledby={`pestana-${seccion}`}>
        {error && !matriz && (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-danger-500/30 bg-danger-500/5 p-4">
            <p role="alert" className="text-sm text-danger-600">
              {error}
            </p>
            <Button variant="outline" onClick={cargar}>
              Reintentar
            </Button>
          </div>
        )}
        {!matriz && !error && <Spinner />}
        {matriz && seccion === 'permisos' && (
          <MatrizPermisos matriz={matriz} token={token} filtro={filtro} onFiltro={setFiltro} onCambio={alCambiar} onError={setAviso} />
        )}
        {matriz && seccion === 'simulador' && (
          <SimuladorPermisos
            key={version}
            matriz={matriz}
            token={token}
            onVerEnMatriz={(clave) => {
              setFiltro(clave);
              irA('permisos');
            }}
          />
        )}
        {matriz && seccion === 'cuentas' && <CuentasYRoles matriz={matriz} token={token} onCambio={alCambiar} />}
        {seccion === 'auditoria' && <AuditoriaAcceso token={token} version={version} />}
      </div>

      <Toast mensaje={aviso} tipo={/no se pudo|no existe|ya no|rechaz/i.test(aviso) ? 'error' : 'exito'} onCerrar={() => setAviso('')} />
    </div>
  );
}
