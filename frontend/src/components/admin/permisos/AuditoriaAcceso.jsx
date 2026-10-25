import { useEffect, useState } from 'react';
import { permisosApi } from '../../../api/permisos';
import { Button } from '../../common/Button';
import { Spinner } from '../../common/Spinner';
import { describirRegistro, etiquetaDeTipo, TIPOS_DE_AUDITORIA } from '../../../utils/permisos';
import { Aviso, CampoTexto, Chip } from './piezas';
import { ENTRADA, formatoFechaHora } from './estilos';

const TONO_DE_TIPO = { regla: 'brand', restaurar: 'warning', rol_cuenta: 'accent', rol_creado: 'neutro', rol_eliminado: 'neutro', denegacion: 'danger' };
const TAMANO = 15;
const FILTROS_INICIALES = { tipo: 'cambios', actor: '', desde: '', hasta: '' };

// El registro de quién cambió qué permiso y de los accesos que se denegaron. Vive en una colección de MongoDB que el
// servidor web solo puede leer e insertar: ni un bug lo reescribe. Se puede filtrar (tipo, quién, fechas) y descargar en
// CSV, como el registro de auditoría de GitHub. De quién actuó se guarda solo el número de cuenta: el nombre se
// resuelve acá, al leer, y una cuenta que ya no existe se ve como tal.
export function AuditoriaAcceso({ token, version }) {
  const [formulario, setFormulario] = useState(FILTROS_INICIALES);
  const [aplicados, setAplicados] = useState(FILTROS_INICIALES);
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  const [descargando, setDescargando] = useState(false);

  useEffect(() => {
    let vigente = true;
    permisosApi
      .auditoria({ ...aplicados, pagina, tamano: TAMANO }, token)
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
  }, [aplicados, pagina, token, version]);

  const cambiar = (campo) => (e) => setFormulario((actual) => ({ ...actual, [campo]: e.target.value }));
  const filtrar = (e) => {
    e.preventDefault();
    setPagina(1);
    setAplicados(formulario);
  };

  async function descargar() {
    setDescargando(true);
    setError('');
    try {
      const { blob, nombre } = await permisosApi.exportarAuditoria(aplicados, token);
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = nombre;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setDescargando(false);
    }
  }

  return (
    <section aria-labelledby="titulo-auditoria" className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 id="titulo-auditoria" className="text-lg font-bold text-neutral-900">
          Auditoría
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Quién cambió qué permiso y qué accesos se negaron. Los cambios se guardan siempre; los accesos denegados, 90 días. Nadie —ni el servidor
          web— puede modificar ni borrar un registro.
        </p>
      </div>

      <form onSubmit={filtrar} className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-4">
        <CampoTexto id="aud-tipo" etiqueta="Qué">
          <select id="aud-tipo" value={formulario.tipo} onChange={cambiar('tipo')} className={ENTRADA}>
            {TIPOS_DE_AUDITORIA.map((t) => (
              <option key={t.valor} value={t.valor}>
                {t.texto}
              </option>
            ))}
          </select>
        </CampoTexto>
        <CampoTexto id="aud-actor" etiqueta="Quién (correo, nombre o número)">
          <input id="aud-actor" value={formulario.actor} onChange={cambiar('actor')} placeholder="admin@…" className={`${ENTRADA} w-56`} />
        </CampoTexto>
        <CampoTexto id="aud-desde" etiqueta="Desde">
          <input id="aud-desde" type="date" value={formulario.desde} onChange={cambiar('desde')} className={ENTRADA} />
        </CampoTexto>
        <CampoTexto id="aud-hasta" etiqueta="Hasta">
          <input id="aud-hasta" type="date" value={formulario.hasta} onChange={cambiar('hasta')} className={ENTRADA} />
        </CampoTexto>
        <Button type="submit" variant="primary" className="!py-2">
          Filtrar
        </Button>
        <Button type="button" variant="outline" onClick={descargar} disabled={descargando} className="!py-2">
          {descargando ? 'Preparando…' : 'Descargar CSV'}
        </Button>
      </form>

      {error && <Aviso tipo="error">{error}</Aviso>}
      {!datos && !error && <Spinner />}
      {datos && (
        <>
          <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th scope="col" className="px-4 py-2.5 font-semibold">Cuándo</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Tipo</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Quién</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Qué</th>
                </tr>
              </thead>
              <tbody>
                {datos.registros.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-neutral-500">
                      No hay registros con esos filtros.
                    </td>
                  </tr>
                )}
                {datos.registros.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-500">{formatoFechaHora(r.fecha)}</td>
                    <td className="px-3 py-2.5">
                      <Chip tono={TONO_DE_TIPO[r.tipo] ?? 'neutro'}>{etiquetaDeTipo(r.tipo)}</Chip>
                    </td>
                    <td className="px-3 py-2.5">
                      {r.actor.eliminada ? (
                        <span className="text-neutral-500">Cuenta #{r.actor.id} (ya no existe)</span>
                      ) : (
                        <>
                          <span className="block font-medium text-neutral-900">{r.actor.nombre ?? `Cuenta #${r.actor.id}`}</span>
                          <span className="text-xs text-neutral-500">{r.actor.correo ?? ''}{r.actor.rol ? ` · ${r.actor.rol}` : ''}</span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-neutral-800">
                      {describirRegistro(r)}
                      {r.tipo === 'denegacion' && <span className="block text-xs text-neutral-500">con el rol «{r.actor.rol}»</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-neutral-600">
            <span>
              {datos.total} {datos.total === 1 ? 'registro' : 'registros'} · página {datos.pagina} de {datos.paginas}
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
    </section>
  );
}
