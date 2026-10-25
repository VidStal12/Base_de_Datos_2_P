import { useMemo, useState } from 'react';
import { permisosApi } from '../../../api/permisos';
import { Button } from '../../common/Button';
import { Modal } from '../../common/Modal';
import { agruparRutas, cambiosPendientes, celdasModificadas, conCelda, describirCambio, filtrarRutas, ordenarRoles, valorMostrado } from '../../../utils/permisos';
import { Aviso, Candado, Chip } from './piezas';
import { ENTRADA, formatoFechaHora } from './estilos';

// Una casilla de la matriz. Tres cosas se distinguen a simple vista: lo que está permitido, lo que un administrador
// cambió respecto del código (borde azul) y lo que todavía no se guardó (borde ámbar). Las casillas bloqueadas
// (la columna del administrador y las rutas fijas) no se pueden marcar y dicen por qué.
function Casilla({ celda, valor, pendiente, rol, ruta, onCambiar }) {
  const modificada = celda.origen === 'regla' && !pendiente;
  const bloqueada = celda.bloqueada;
  const motivo = bloqueada
    ? rol === 'administrador'
      ? 'El administrador conserva todas las rutas: nadie puede quedarse sin acceso.'
      : `Ruta fija: ${ruta.fija}`
    : modificada
      ? `Cambiado${celda.modificadoPor ? ` por ${celda.modificadoPor}` : ''} (${formatoFechaHora(celda.modificadoEn)}). El código declara: ${celda.porDefecto ? 'permitido' : 'negado'}.`
      : pendiente
        ? 'Sin guardar: se aplica cuando guardes los cambios.'
        : celda.porDefecto
          ? 'Lo permite el código.'
          : 'Negado por defecto: lo que no figura en la lista blanca se niega.';

  const borde = pendiente ? 'border-warning-500 ring-2 ring-warning-500/40' : modificada ? 'border-brand-600 ring-2 ring-brand-600/30' : 'border-neutral-300';
  const relleno = valor ? (modificada || pendiente ? 'bg-brand-600 text-white' : 'bg-accent-600 text-white') : 'bg-white text-transparent';

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={valor}
      aria-disabled={bloqueada}
      aria-label={`${rol}: ${ruta.nota}`}
      title={motivo}
      onClick={() => !bloqueada && onCambiar(!valor)}
      className={`relative mx-auto flex size-6 items-center justify-center rounded-md border text-sm font-bold transition-colors ${borde} ${relleno} ${
        bloqueada ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-brand-600'
      } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500`}
    >
      {valor ? '✓' : '·'}
      {bloqueada && rol !== 'administrador' && (
        <Candado className="absolute -right-1.5 -top-1.5 size-3 text-neutral-500" />
      )}
    </button>
  );
}

function Leyenda() {
  const ejemplo = (clases, texto) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`flex size-4 items-center justify-center rounded border text-[10px] font-bold ${clases}`}>
        {texto}
      </span>
    </span>
  );
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-neutral-600">
      <li className="flex items-center gap-1.5">{ejemplo('border-neutral-300 bg-accent-600 text-white', '✓')} permitido por el código</li>
      <li className="flex items-center gap-1.5">{ejemplo('border-brand-600 bg-brand-600 text-white ring-2 ring-brand-600/30', '✓')} concedido por un administrador</li>
      <li className="flex items-center gap-1.5">{ejemplo('border-brand-600 bg-white text-transparent ring-2 ring-brand-600/30', '·')} quitado por un administrador</li>
      <li className="flex items-center gap-1.5">{ejemplo('border-warning-500 bg-white text-transparent ring-2 ring-warning-500/40', '·')} sin guardar</li>
      <li className="flex items-center gap-1.5">
        <Candado className="size-3.5 text-neutral-500" /> fija: no se puede cambiar desde acá
      </li>
    </ul>
  );
}

export function MatrizPermisos({ matriz, token, filtro, onFiltro, onCambio, onError }) {
  const [borrador, setBorrador] = useState(() => new Map());
  const [soloEditables, setSoloEditables] = useState(false);
  const [dialogo, setDialogo] = useState(null); // 'guardar' | 'restaurar'
  const [trabajando, setTrabajando] = useState(false);
  const [errorDialogo, setErrorDialogo] = useState('');

  const roles = useMemo(() => ordenarRoles(matriz.roles), [matriz.roles]);
  const visibles = useMemo(() => filtrarRutas(matriz.rutas, filtro, { soloEditables }), [matriz.rutas, filtro, soloEditables]);
  const grupos = useMemo(() => agruparRutas(visibles), [visibles]);
  const pendientes = useMemo(() => cambiosPendientes(matriz.rutas, borrador), [matriz.rutas, borrador]);
  const modificadas = useMemo(() => celdasModificadas(matriz.rutas), [matriz.rutas]);
  const marcadas = useMemo(() => new Set(pendientes.map((c) => `${c.rol}\u0000${c.clave}`)), [pendientes]);

  async function ejecutar(accion, mensaje) {
    setTrabajando(true);
    setErrorDialogo('');
    try {
      const respuesta = await accion();
      setBorrador(new Map());
      setDialogo(null);
      await onCambio(typeof mensaje === 'function' ? mensaje(respuesta) : mensaje);
    } catch (err) {
      // Una matriz desactualizada (otro administrador cambió algo) se dice con el mismo mensaje del servidor.
      setErrorDialogo(err.message);
      onError?.(err.message);
    } finally {
      setTrabajando(false);
    }
  }

  const guardar = () =>
    ejecutar(
      () => permisosApi.aplicar(pendientes.map(({ clave, rol, permitido }) => ({ clave, rol, permitido })), token),
      (r) => `Se aplicaron ${r.aplicados.length} ${r.aplicados.length === 1 ? 'cambio' : 'cambios'}${r.auditado ? '' : ' (no se pudo registrar en la auditoría: MongoDB no responde)'}.`
    );
  const restaurarTodo = () => ejecutar(() => permisosApi.restaurar({}, token), (r) => `Se restauró lo que declara el código (${r.restauradas} ${r.restauradas === 1 ? 'regla' : 'reglas'}).`);
  const restaurarRuta = (ruta) => ejecutar(() => permisosApi.restaurar({ clave: ruta.clave }, token), `«${ruta.nota}» volvió a lo que declara el código.`);

  const quitan = pendientes.filter((c) => describirCambio(c).quita);

  return (
    <section aria-labelledby="titulo-matriz" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="titulo-matriz" className="text-lg font-bold text-neutral-900">
            Qué puede hacer cada rol
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            La base es la lista blanca del código: lo que no figura se niega. Acá un administrador concede o quita rutas a un rol; solo se guarda la
            diferencia con el código, y rige en segundos. El administrador conserva siempre todo.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filtro}
            onChange={(e) => onFiltro(e.target.value)}
            placeholder="Buscar una acción…"
            aria-label="Buscar una acción"
            className={`${ENTRADA} w-56`}
          />
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" checked={soloEditables} onChange={(e) => setSoloEditables(e.target.checked)} className="size-4 accent-brand-600" />
            Solo lo que se puede cambiar
          </label>
          <Button variant="outline" onClick={() => setDialogo('restaurar')} disabled={modificadas.length === 0 || pendientes.length > 0} title="Vuelve todo a lo que declara el código">
            Restaurar lo del código{modificadas.length > 0 ? ` (${modificadas.length})` : ''}
          </Button>
        </div>
      </div>

      <Leyenda />

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left">
              <th scope="col" className="sticky left-0 z-10 min-w-72 bg-neutral-50 px-4 py-3 font-semibold text-neutral-700">
                Acción
              </th>
              {roles.map((rol) => (
                <th key={rol.nombre} scope="col" className="px-3 py-3 text-center font-semibold text-neutral-700">
                  <span className="block capitalize">{rol.nombre}</span>
                  <span className="mt-0.5 block text-xs font-normal text-neutral-500">
                    {rol.sistema ? 'del sistema' : 'creado'} · {rol.usuarios} {rol.usuarios === 1 ? 'cuenta' : 'cuentas'}
                  </span>
                </th>
              ))}
              <th scope="col" className="w-12 px-2 py-3">
                <span className="sr-only">Restaurar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grupos.length === 0 && (
              <tr>
                <td colSpan={roles.length + 2} className="px-4 py-8 text-center text-neutral-500">
                  Ninguna acción coincide con la búsqueda.
                </td>
              </tr>
            )}
            {grupos.map(({ grupo, rutas }) => (
              <GrupoDeFilas key={grupo} grupo={grupo} rutas={rutas} roles={roles} borrador={borrador} marcadas={marcadas} onCelda={(clave, rol, valor) => setBorrador((actual) => conCelda(actual, matriz.rutas, clave, rol, valor))} onRestaurar={restaurarRuta} trabajando={trabajando} columnas={roles.length + 2} />
            ))}
          </tbody>
        </table>
      </div>

      {pendientes.length > 0 && (
        <div role="region" aria-label="Cambios sin guardar" className="sticky bottom-4 z-30 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-white shadow-lg">
          <p className="text-sm font-medium">
            {pendientes.length} {pendientes.length === 1 ? 'cambio sin guardar' : 'cambios sin guardar'}
            {quitan.length > 0 && <span className="ml-2 text-warning-500">· {quitan.length} {quitan.length === 1 ? 'quita' : 'quitan'} un permiso que hoy se usa</span>}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setBorrador(new Map())} className="!py-1.5">
              Descartar
            </Button>
            <Button variant="accent" onClick={() => setDialogo('guardar')} className="!py-1.5">
              Revisar y guardar
            </Button>
          </div>
        </div>
      )}

      {dialogo === 'guardar' && (
        <Modal
          titulo="Guardar los cambios de permisos"
          bloqueado={trabajando}
          onCancelar={() => !trabajando && setDialogo(null)}
          descripcion={
            <>
              <p>Esto es lo que va a cambiar. Rige en segundos, sin que nadie tenga que volver a iniciar sesión, y queda en el registro de auditoría.</p>
              <ul className="max-h-60 list-disc space-y-1 overflow-y-auto pl-5">
                {pendientes.map((c) => {
                  const d = describirCambio(c);
                  return (
                    <li key={`${c.rol}${c.clave}`}>
                      {d.texto}
                      {d.quita && <span className="ml-1 text-warning-500">(hoy lo puede usar)</span>}
                    </li>
                  );
                })}
              </ul>
              {quitan.length > 0 && <Aviso tipo="aviso">Quitar un permiso corta el acceso de las cuentas de ese rol que hoy lo usan, en cuanto se guarda.</Aviso>}
              {errorDialogo && <Aviso tipo="error">{errorDialogo}</Aviso>}
            </>
          }
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogo(null)} disabled={trabajando}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={guardar} disabled={trabajando} data-enfoque-inicial>
              {trabajando ? 'Guardando…' : `Aplicar ${pendientes.length} ${pendientes.length === 1 ? 'cambio' : 'cambios'}`}
            </Button>
          </div>
        </Modal>
      )}

      {dialogo === 'restaurar' && (
        <Modal
          titulo="Restaurar lo que declara el código"
          bloqueado={trabajando}
          onCancelar={() => !trabajando && setDialogo(null)}
          descripcion={
            <>
              <p>Se borran estas {modificadas.length} {modificadas.length === 1 ? 'regla' : 'reglas'} y cada rol vuelve a lo que dice la lista blanca del código:</p>
              <ul className="max-h-60 list-disc space-y-1 overflow-y-auto pl-5">
                {modificadas.map((m) => (
                  <li key={`${m.rol}${m.clave}`}>
                    «{m.nota}» para <strong>{m.rol}</strong>: hoy {m.permitido ? 'permitido' : 'negado'}
                  </li>
                ))}
              </ul>
              {errorDialogo && <Aviso tipo="error">{errorDialogo}</Aviso>}
            </>
          }
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogo(null)} disabled={trabajando}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={restaurarTodo} disabled={trabajando} data-enfoque-inicial>
              {trabajando ? 'Restaurando…' : 'Restaurar todo'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function GrupoDeFilas({ grupo, rutas, roles, borrador, marcadas, onCelda, onRestaurar, trabajando, columnas }) {
  return (
    <>
      <tr className="bg-neutral-50/70">
        <th scope="rowgroup" colSpan={columnas} className="sticky left-0 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {grupo}
        </th>
      </tr>
      {rutas.map((ruta) => {
        const tieneRegla = Object.values(ruta.celdas).some((c) => c.origen === 'regla');
        return (
          <tr key={ruta.clave} className="border-t border-neutral-100 hover:bg-neutral-50/60">
            <th scope="row" className="sticky left-0 z-10 bg-white px-4 py-2.5 text-left font-normal">
              <span className="block text-neutral-900">{ruta.nota}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <code className="text-xs text-neutral-500">{ruta.clave}</code>
                {ruta.propios && <Chip tono="neutro" title="Además de la ruta, el servicio comprueba que el recurso sea de quien pregunta (o que sea administrador).">solo lo propio</Chip>}
                {!ruta.editable && <Chip tono="warning" title={ruta.fija}>fija</Chip>}
              </span>
            </th>
            {roles.map((rol) => {
              const celda = ruta.celdas[rol.nombre];
              if (!celda) return <td key={rol.nombre} />;
              return (
                <td key={rol.nombre} className="px-3 py-2.5 text-center">
                  <Casilla
                    celda={celda}
                    valor={valorMostrado(celda, borrador, ruta.clave, rol.nombre)}
                    pendiente={marcadas.has(`${rol.nombre}\u0000${ruta.clave}`)}
                    rol={rol.nombre}
                    ruta={ruta}
                    onCambiar={(valor) => onCelda(ruta.clave, rol.nombre, valor)}
                  />
                </td>
              );
            })}
            <td className="px-2 py-2.5 text-center">
              {tieneRegla && (
                <button
                  type="button"
                  onClick={() => onRestaurar(ruta)}
                  disabled={trabajando || borrador.size > 0}
                  title="Volver a lo que declara el código en esta acción"
                  aria-label={`Restaurar «${ruta.nota}» a lo que declara el código`}
                  className="rounded p-1 text-base text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ↺
                </button>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}
