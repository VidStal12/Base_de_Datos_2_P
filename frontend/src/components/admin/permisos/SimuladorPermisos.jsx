import { useMemo, useState } from 'react';
import { permisosApi } from '../../../api/permisos';
import { Button } from '../../common/Button';
import { agruparRutas, ordenarRoles, permisosDeRol } from '../../../utils/permisos';
import { Aviso, CampoTexto, Chip } from './piezas';
import { ENTRADA, formatoFechaHora } from './estilos';

// El simulador: «¿puede este rol —o esta cuenta— usar esta ruta?». Le pregunta al servidor, que responde con la MISMA
// decisión que aplica a cada petición (una sola función en el backend), y dice por qué: si lo permite el código o lo
// cambió un administrador, o si la ruta es fija. Es lo que hace un simulador de políticas (AWS IAM) o un «can-i».
export function SimuladorPermisos({ matriz, token, onVerEnMatriz }) {
  const roles = useMemo(() => ordenarRoles(matriz.roles), [matriz.roles]);
  const grupos = useMemo(() => agruparRutas(matriz.rutas), [matriz.rutas]);
  const [modo, setModo] = useState('rol');
  const [rol, setRol] = useState(roles.find((r) => !r.sistema)?.nombre ?? roles[0]?.nombre ?? '');
  const [clave, setClave] = useState(matriz.rutas[0]?.clave ?? '');
  const [busqueda, setBusqueda] = useState('');
  const [candidatas, setCandidatas] = useState(null);
  const [cuenta, setCuenta] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState('');
  const [trabajando, setTrabajando] = useState(false);

  async function buscarCuentas(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await permisosApi.usuarios({ q: busqueda.trim(), tamano: 8 }, token);
      setCandidatas(r.usuarios);
    } catch (err) {
      setError(err.message);
    }
  }

  async function probar(e) {
    e.preventDefault();
    setError('');
    setResultado(null);
    setTrabajando(true);
    try {
      setResultado(await permisosApi.simular(modo === 'rol' ? { clave, rol } : { clave, usuarioId: cuenta.id }, token));
    } catch (err) {
      setError(err.message);
    } finally {
      setTrabajando(false);
    }
  }

  const puedeProbar = clave && (modo === 'rol' ? rol : cuenta);
  const delRol = useMemo(() => (modo === 'rol' && rol ? permisosDeRol(matriz.rutas, rol) : []), [modo, rol, matriz.rutas]);

  return (
    <section aria-labelledby="titulo-simulador" className="flex flex-col gap-5">
      <div className="max-w-2xl">
        <h2 id="titulo-simulador" className="text-lg font-bold text-neutral-900">
          Simulador: ¿puede hacerlo?
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Elegí un rol (o una cuenta) y una acción: la respuesta es la misma decisión que aplica la API en cada petición, con el motivo. Sirve para
          comprobar un cambio antes de guardarlo, o para entender por qué a alguien se le negó algo.
        </p>
      </div>

      <form onSubmit={probar} className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-4">
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">Quién pregunta</legend>
          {[
            ['rol', 'Un rol'],
            ['cuenta', 'Una cuenta'],
          ].map(([valor, texto]) => (
            <label key={valor} className="flex items-center gap-2">
              <input type="radio" name="modo" value={valor} checked={modo === valor} onChange={() => { setModo(valor); setResultado(null); }} className="accent-brand-600" />
              {texto}
            </label>
          ))}
        </fieldset>

        <div className="grid gap-4 md:grid-cols-2">
          {modo === 'rol' ? (
            <CampoTexto id="sim-rol" etiqueta="Rol">
              <select id="sim-rol" value={rol} onChange={(e) => { setRol(e.target.value); setResultado(null); }} className={`${ENTRADA} w-full min-w-0`}>
                {roles.map((r) => (
                  <option key={r.nombre} value={r.nombre}>
                    {r.nombre}
                    {r.sistema ? '' : ' (creado)'}
                  </option>
                ))}
              </select>
            </CampoTexto>
          ) : (
            <div className="flex flex-col gap-2">
              <CampoTexto id="sim-cuenta" etiqueta="Cuenta (correo o nombre)">
                <div className="flex gap-2">
                  <input id="sim-cuenta" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="rosa@…" className={`${ENTRADA} min-w-0 flex-1`} />
                  <Button type="button" variant="outline" onClick={buscarCuentas} className="!py-2">
                    Buscar
                  </Button>
                </div>
              </CampoTexto>
              {cuenta && (
                <p className="text-sm text-neutral-700">
                  Cuenta elegida: <strong>{cuenta.nombre}</strong> <span className="text-neutral-500">#{cuenta.id} · {cuenta.rol}</span>
                </p>
              )}
              {candidatas && (
                <ul className="max-h-40 divide-y divide-neutral-100 overflow-y-auto rounded-lg border border-neutral-200 text-sm">
                  {candidatas.length === 0 && <li className="px-3 py-2 text-neutral-500">Ninguna cuenta coincide.</li>}
                  {candidatas.map((u) => (
                    <li key={u.id}>
                      <button type="button" onClick={() => { setCuenta(u); setCandidatas(null); setResultado(null); }} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-brand-50">
                        <span>
                          {u.nombre} <span className="text-neutral-500">{u.correo}</span>
                        </span>
                        <Chip>{u.rol}</Chip>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <CampoTexto id="sim-accion" etiqueta="Acción">
            <select id="sim-accion" value={clave} onChange={(e) => { setClave(e.target.value); setResultado(null); }} className={`${ENTRADA} w-full min-w-0`}>
              {grupos.map((g) => (
                <optgroup key={g.grupo} label={g.grupo}>
                  {g.rutas.map((r) => (
                    <option key={r.clave} value={r.clave}>
                      {r.nota}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </CampoTexto>
        </div>

        <div>
          <Button type="submit" variant="primary" disabled={!puedeProbar || trabajando}>
            {trabajando ? 'Consultando…' : 'Probar'}
          </Button>
        </div>
      </form>

      {error && <Aviso tipo="error">{error}</Aviso>}

      {resultado && (
        <article aria-live="polite" className={`rounded-xl border p-4 ${resultado.permitido ? 'border-accent-500/40 bg-accent-500/5' : 'border-danger-500/30 bg-danger-500/5'}`}>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-lg px-3 py-1 text-sm font-bold uppercase tracking-wide ${resultado.permitido ? 'bg-accent-600 text-white' : 'bg-danger-600 text-white'}`}>
              {resultado.permitido ? 'Permitido' : 'Denegado'}
            </span>
            <p className="text-sm text-neutral-800">
              {resultado.cuenta ? (
                <>
                  <strong>{resultado.cuenta.nombre}</strong> ({resultado.rol})
                </>
              ) : (
                <>
                  El rol <strong>{resultado.rol}</strong>
                </>
              )}{' '}
              {resultado.permitido ? 'puede' : 'no puede'}: «{resultado.ruta.nota}»
            </p>
          </div>
          <p className="mt-3 text-sm text-neutral-800">{resultado.motivo}</p>
          {resultado.detalles.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-neutral-600">
              {resultado.detalles.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
            <code>{resultado.ruta.clave}</code>
            <Chip tono={resultado.origen === 'regla' ? 'brand' : 'neutro'}>
              {{ regla: 'por una regla de un administrador', codigo: 'por el código', administrador: 'administrador', publica: 'ruta pública', opcional: 'ruta pública', sesion: 'solo pide sesión', 'sin-rol': 'sin rol' }[resultado.origen] ?? resultado.origen}
            </Chip>
            {resultado.regla && <span>Regla del {formatoFechaHora(resultado.regla.modificadoEn)}</span>}
            {resultado.ruta.acceso === 'roles' && (
              <button type="button" onClick={() => onVerEnMatriz(resultado.ruta.clave)} className="font-medium text-brand-700 hover:underline">
                Ver en la matriz
              </button>
            )}
          </div>
        </article>
      )}

      {modo === 'rol' && rol && (
        <section aria-label={`Todo lo que puede hacer el rol ${rol}`} className="rounded-xl border border-neutral-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-neutral-800">
            Todo lo que puede hacer hoy el rol «{rol}» <span className="font-normal text-neutral-500">(entre las acciones que piden un rol)</span>
          </h3>
          {delRol.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-600">Nada: solo lo que no pide rol (comprar, ver el catálogo, reseñar…). Se le concede desde la matriz.</p>
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {delRol.map((g) => (
                <div key={g.grupo}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{g.grupo}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
                    {g.rutas.map((r) => (
                      <li key={r.clave}>{r.nota}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
