import { useCallback, useEffect, useMemo, useState } from 'react';
import { permisosApi } from '../../../api/permisos';
import { useAuth } from '../../../context/AuthContext';
import { Button } from '../../common/Button';
import { Modal } from '../../common/Modal';
import { Spinner } from '../../common/Spinner';
import { ordenarRoles } from '../../../utils/permisos';
import { Aviso, CampoTexto, Chip } from './piezas';
import { ENTRADA, formatoFechaHora } from './estilos';

// Los roles y a quién se le asigna cada uno. Un rol creado acá empieza sin permisos más que los de un comprador: se
// le conceden, una por una, las acciones de la matriz. Cambiar el rol de una cuenta rige en segundos (el servidor
// decide con el rol de hoy, no con el que dice el token), y quedan guardados quién lo hizo y cuándo.
function PanelDeRoles({ matriz, token, onCambio }) {
  const roles = useMemo(() => ordenarRoles(matriz.roles), [matriz.roles]);
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState('');
  const [trabajando, setTrabajando] = useState(false);
  const [aBorrar, setABorrar] = useState(null);

  async function crear(e) {
    e.preventDefault();
    setError('');
    setTrabajando(true);
    try {
      const creado = await permisosApi.crearRol(nombre, token);
      setNombre('');
      await onCambio(`Se creó el rol «${creado.nombre}»: empieza sin permisos extra. Concedele acciones desde la matriz.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTrabajando(false);
    }
  }

  async function borrar() {
    setTrabajando(true);
    setError('');
    try {
      const r = await permisosApi.borrarRol(aBorrar.id, token);
      setABorrar(null);
      await onCambio(`Se borró el rol «${r.eliminado}»${r.reglasBorradas > 0 ? ` y sus ${r.reglasBorradas} permisos` : ''}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <section aria-labelledby="titulo-roles" className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4">
      <h3 id="titulo-roles" className="text-base font-bold text-neutral-900">
        Roles
      </h3>
      <ul className="divide-y divide-neutral-100">
        {roles.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="flex items-center gap-2">
              <strong className="capitalize">{r.nombre}</strong>
              <Chip tono={r.sistema ? 'neutro' : 'brand'}>{r.sistema ? 'del sistema' : 'creado'}</Chip>
              <span className="text-neutral-500">
                {r.usuarios} {r.usuarios === 1 ? 'cuenta' : 'cuentas'}
              </span>
            </span>
            {!r.sistema && (
              <Button variant="danger" onClick={() => { setError(''); setABorrar(r); }} className="!px-3 !py-1" disabled={trabajando}>
                Borrar
              </Button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={crear} className="flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-3">
        <CampoTexto id="rol-nuevo" etiqueta="Rol nuevo">
          <input
            id="rol-nuevo"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="auditor"
            maxLength={30}
            autoComplete="off"
            className={`${ENTRADA} w-52`}
          />
        </CampoTexto>
        <Button type="submit" variant="primary" disabled={!nombre.trim() || trabajando} className="!py-2">
          Crear rol
        </Button>
      </form>
      <p className="text-xs text-neutral-500">Minúsculas, de 3 a 30 caracteres: letras, números, guion o guion bajo, y empieza con una letra.</p>
      {error && !aBorrar && <Aviso tipo="error">{error}</Aviso>}

      {aBorrar && (
        <Modal
          titulo={`Borrar el rol «${aBorrar.nombre}»`}
          bloqueado={trabajando}
          onCancelar={() => !trabajando && setABorrar(null)}
          descripcion={
            <>
              <p>Se borra el rol y los permisos que se le habían concedido. Solo se puede si ninguna cuenta lo tiene.</p>
              {aBorrar.usuarios > 0 && <Aviso tipo="aviso">Hoy lo tienen {aBorrar.usuarios} {aBorrar.usuarios === 1 ? 'cuenta' : 'cuentas'}: cambiales el rol primero.</Aviso>}
              {error && <Aviso tipo="error">{error}</Aviso>}
            </>
          }
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setABorrar(null)} disabled={trabajando}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={borrar} disabled={trabajando || aBorrar.usuarios > 0} data-enfoque-inicial>
              {trabajando ? 'Borrando…' : 'Borrar el rol'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const TAMANO = 10;

function PanelDeCuentas({ matriz, token, onCambio }) {
  const { usuario: yo } = useAuth();
  const roles = useMemo(() => ordenarRoles(matriz.roles), [matriz.roles]);
  const [texto, setTexto] = useState('');
  const [q, setQ] = useState('');
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  const [elegidos, setElegidos] = useState({}); // id → rol escogido y todavía sin confirmar
  const [confirmando, setConfirmando] = useState(null);
  const [trabajando, setTrabajando] = useState(false);
  const [errorDialogo, setErrorDialogo] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let vigente = true;
    permisosApi
      .usuarios({ q, pagina, tamano: TAMANO }, token)
      .then((r) => {
        if (vigente) {
          setDatos(r);
          setError('');
        }
      })
      .catch((err) => vigente && setError(err.message));
    return () => {
      vigente = false;
    };
  }, [q, pagina, token, version]);

  const buscar = (e) => {
    e.preventDefault();
    setPagina(1);
    setQ(texto.trim());
  };

  const confirmar = useCallback(async () => {
    setTrabajando(true);
    setErrorDialogo('');
    try {
      const r = await permisosApi.cambiarRol(confirmando.cuenta.id, confirmando.rol, token);
      setConfirmando(null);
      setElegidos((actual) => {
        const siguiente = { ...actual };
        delete siguiente[confirmando.cuenta.id];
        return siguiente;
      });
      setVersion((v) => v + 1);
      await onCambio(r.sinCambios ? 'La cuenta ya tenía ese rol.' : `${confirmando.cuenta.nombre} ahora es «${r.rol}».${r.auditado ? '' : ' (No se pudo registrar en la auditoría: MongoDB no responde).'}`);
    } catch (err) {
      setErrorDialogo(err.message);
    } finally {
      setTrabajando(false);
    }
  }, [confirmando, token, onCambio]);

  return (
    <section aria-labelledby="titulo-cuentas" className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id="titulo-cuentas" className="text-base font-bold text-neutral-900">
          Cuentas
        </h3>
        <form onSubmit={buscar} className="flex gap-2">
          <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Buscar por correo, nombre o número…" aria-label="Buscar una cuenta" className={`${ENTRADA} w-64`} />
          <Button type="submit" variant="outline" className="!py-2">
            Buscar
          </Button>
        </form>
      </div>

      {error && <Aviso tipo="error">{error}</Aviso>}
      {!datos && !error && <Spinner />}
      {datos && (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th scope="col" className="py-2 pr-3 font-semibold">Cuenta</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Alta</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Rol</th>
                  <th scope="col" className="py-2 font-semibold"><span className="sr-only">Acción</span></th>
                </tr>
              </thead>
              <tbody>
                {datos.usuarios.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-neutral-500">
                      Ninguna cuenta coincide.
                    </td>
                  </tr>
                )}
                {datos.usuarios.map((u) => {
                  const propia = yo?.id_usuario === u.id;
                  const elegido = elegidos[u.id] ?? u.rol;
                  return (
                    <tr key={u.id} className="border-b border-neutral-100">
                      <td className="py-2 pr-3">
                        <span className="block font-medium text-neutral-900">
                          {u.nombre} <span className="font-normal text-neutral-400">#{u.id}</span>
                        </span>
                        <span className="text-xs text-neutral-500">{u.correo}</span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-neutral-500">{formatoFechaHora(u.creadoEn)}</td>
                      <td className="py-2 pr-3">
                        <select
                          aria-label={`Rol de ${u.nombre}`}
                          value={elegido}
                          disabled={propia}
                          title={propia ? 'No podés cambiar tu propio rol: pedíselo a otro administrador.' : undefined}
                          onChange={(e) => setElegidos((actual) => ({ ...actual, [u.id]: e.target.value }))}
                          className={`${ENTRADA} !py-1.5 disabled:cursor-not-allowed disabled:bg-neutral-100`}
                        >
                          {roles.map((r) => (
                            <option key={r.id} value={r.nombre}>
                              {r.nombre}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 text-right">
                        {elegido !== u.rol && !propia && (
                          <Button variant="primary" onClick={() => { setErrorDialogo(''); setConfirmando({ cuenta: u, rol: elegido }); }} className="!px-3 !py-1.5">
                            Cambiar
                          </Button>
                        )}
                        {propia && <Chip>tu cuenta</Chip>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-neutral-600">
            <span>
              {datos.total} {datos.total === 1 ? 'cuenta' : 'cuentas'} · página {datos.pagina} de {datos.paginas}
            </span>
            <span className="flex gap-2">
              <Button variant="outline" onClick={() => setPagina((p) => Math.max(1, p - 1))} disabled={datos.pagina <= 1} className="!px-3 !py-1.5">
                Anterior
              </Button>
              <Button variant="outline" onClick={() => setPagina((p) => p + 1)} disabled={datos.pagina >= datos.paginas} className="!px-3 !py-1.5">
                Siguiente
              </Button>
            </span>
          </div>
        </>
      )}

      {confirmando && (
        <Modal
          titulo="Cambiar el rol de una cuenta"
          bloqueado={trabajando}
          onCancelar={() => !trabajando && setConfirmando(null)}
          descripcion={
            <>
              <p>
                <strong>{confirmando.cuenta.nombre}</strong> <span className="text-neutral-500">({confirmando.cuenta.correo})</span> pasa de{' '}
                <strong>{confirmando.cuenta.rol}</strong> a <strong>{confirmando.rol}</strong>.
              </p>
              <p>Rige en segundos, sin que la persona tenga que volver a iniciar sesión, y queda en el registro de auditoría.</p>
              {confirmando.cuenta.rol === 'vendedor' && (
                <Aviso tipo="aviso">Sus productos siguen en el catálogo, pero ya no podrá editarlos ni crear nuevos.</Aviso>
              )}
              {confirmando.cuenta.rol === 'administrador' && <Aviso tipo="aviso">Pierde el acceso a todo el panel, incluida esta pantalla.</Aviso>}
              {errorDialogo && <Aviso tipo="error">{errorDialogo}</Aviso>}
            </>
          }
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmando(null)} disabled={trabajando}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={confirmar} disabled={trabajando} data-enfoque-inicial>
              {trabajando ? 'Cambiando…' : 'Cambiar el rol'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function CuentasYRoles({ matriz, token, onCambio }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="max-w-2xl">
        <h2 className="text-lg font-bold text-neutral-900">Cuentas y roles</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Un rol creado acá empieza sin permisos más que los de un comprador. Nadie cambia su propio rol, y siempre queda al menos un administrador.
        </p>
      </div>
      <PanelDeRoles matriz={matriz} token={token} onCambio={onCambio} />
      <PanelDeCuentas matriz={matriz} token={token} onCambio={onCambio} />
    </div>
  );
}
