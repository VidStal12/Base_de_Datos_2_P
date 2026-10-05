import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { bloqueosApi } from '../../api/bloqueos';
import { formatoQ } from '../../utils/format';
import { Spinner } from '../../components/common/Spinner';
import { Button } from '../../components/common/Button';
import { FichaUsuario } from '../../components/admin/FichaUsuario';

const formatoFechaHora = (iso) => new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, singular, pluralTexto) => `${n} ${n === 1 ? singular : pluralTexto}`;

function duracionTexto(ms) {
  const minutos = Math.floor(ms / 60000);
  if (minutos < 1) return 'menos de 1 minuto';
  const dias = Math.floor(minutos / 1440);
  const horas = Math.floor((minutos % 1440) / 60);
  if (dias > 0) return `${dias} d ${horas} h`;
  if (horas > 0) return `${horas} h ${minutos % 60} min`;
  return `${minutos} min`;
}

// Lo que rige para una cuenta bajo vigilancia (ver backend/src/services/restriccionService.js):
// 0 en un tope significa que ese tope está desactivado.
function descripcionLimites({ montoMaximo, pedidosPorHora }) {
  const partes = ['su contraseña en cada pedido'];
  if (montoMaximo > 0) partes.push(`hasta ${formatoQ(montoMaximo)} por pedido`);
  if (pedidosPorHora > 0) partes.push(`${plural(pedidosPorHora, 'pedido', 'pedidos')} por hora`);
  return partes.join(' · ');
}

// Un reloj que avanza solo, para que el "se levanta en…" de cada tarjeta no se
// quede quieto mientras el administrador la revisa.
function useAhora(intervaloMs) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), intervaloMs);
    return () => clearInterval(id);
  }, [intervaloMs]);
  return ahora;
}

const TONOS = {
  warning: 'bg-warning-500/10 text-warning-500',
  brand: 'bg-brand-50 text-brand-700',
  accent: 'bg-accent-500/10 text-accent-700',
  danger: 'bg-danger-500/10 text-danger-600',
  neutro: 'bg-neutral-100 text-neutral-600',
};

function Chip({ tono = 'neutro', children }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONOS[tono]}`}>{children}</span>;
}

const Subtitulo = ({ children }) => <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{children}</p>;

// Una suspensión (confianza alta) se ve en rojo; un hallazgo «posible», que deja a la
// cuenta bajo vigilancia, en ámbar.
const MARCOS_CASO = {
  suspension: { caja: 'border-danger-500/30 bg-danger-500/5', linea: 'border-danger-500/20', chip: 'danger' },
  restriccion: { caja: 'border-warning-500/40 bg-warning-500/5', linea: 'border-warning-500/25', chip: 'warning' },
};

// Un hallazgo que abrió el caso: qué señal, el motivo en prosa tal como lo explicó
// el sistema en ese momento, y — desplegable — la evidencia con la que se abrió
// (lo que la corrobora y las cuentas involucradas), que es una copia: no cambia
// aunque el grafo cambie después.
function CasoBloqueo({ caso }) {
  const [abierto, setAbierto] = useState(false);
  const marco = MARCOS_CASO[caso.tipo] ?? MARCOS_CASO.suspension;
  const evidencia = caso.evidencia;
  const corroboradores = evidencia?.corroboradores ?? [];
  const involucradas = evidencia?.involucradas ?? [];

  return (
    <div className={`rounded-lg border p-3 ${marco.caja}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tono={marco.chip}>{caso.senalNombre}</Chip>
        <span className="text-xs text-neutral-500">Detectado el {formatoFechaHora(caso.creadoEn)}</span>
      </div>
      <p className="mt-2 text-sm text-neutral-800">{caso.motivo}</p>
      {(corroboradores.length > 0 || involucradas.length > 0) && (
        <>
          <button type="button" onClick={() => setAbierto((v) => !v)} className="mt-2 text-xs font-medium text-brand-700 hover:underline">
            {abierto ? 'Ocultar evidencia' : 'Ver evidencia'}
          </button>
          {abierto && (
            <div className={`mt-2 border-t pt-2 ${marco.linea}`}>
              {corroboradores.length > 0 && (
                <>
                  <Subtitulo>Qué lo corrobora</Subtitulo>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
                    {corroboradores.map((c, i) => (
                      <li key={i}>{c.detalle}</li>
                    ))}
                  </ul>
                </>
              )}
              {involucradas.length > 0 && (
                <>
                  <Subtitulo>Cuentas involucradas</Subtitulo>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-neutral-700">
                    {involucradas.map((c) => (
                      <li key={`${c.id}-${c.papel}`}>
                        {c.nombre} <span className="text-neutral-400">#{c.id}</span> — {c.papel}
                        {c.rol ? ` (${c.rol})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// El estado que comparten las tarjetas de una cuenta: la nota de la revisión, el paso de
// confirmación y la llamada que decide. `accion` recibe la nota escrita; `mensaje` es lo
// que la pantalla avisa si salió bien.
function useDecision(onCambio) {
  const [nota, setNota] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState('');

  async function decidir(accion, mensaje) {
    setTrabajando(true);
    setError('');
    try {
      await accion(nota);
      setNota('');
      setConfirmando(false);
      await onCambio(mensaje);
    } catch (err) {
      setError(err.message);
    } finally {
      setTrabajando(false);
    }
  }

  return { nota, setNota, confirmando, setConfirmando, trabajando, error, decidir };
}

function CampoNota({ id, decision }) {
  return (
    <>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Nota de la revisión (opcional)
      </label>
      <input
        id={id}
        value={decision.nota}
        onChange={(e) => decision.setNota(e.target.value)}
        maxLength={500}
        placeholder="Qué revisaste y por qué decidís esto"
        disabled={decision.trabajando}
        className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-2 focus:outline-accent-500"
      />
      {decision.error && <p className="mt-2 text-sm text-danger-600">{decision.error}</p>}
    </>
  );
}

// Una cuenta suspendida y la decisión que un administrador toma sobre ella:
// levantarla (era un falso positivo — "dar el visto bueno") o extenderla. Levantar
// pide confirmación porque es lo único que reabre una cuenta antes de que venza.
function TarjetaBloqueo({ activa, ahora, token, onCambio }) {
  const decision = useDecision(onCambio);
  const restanteMs = new Date(activa.expiraEn).getTime() - ahora;
  const { usuario, revisado } = activa;

  const liberar = () => decision.decidir((nota) => bloqueosApi.liberar(usuario.id, nota, token), `Se levantó el bloqueo de ${usuario.nombre}. Ese hallazgo no volverá a suspenderla.`);
  const extender = (horas, texto) => decision.decidir((nota) => bloqueosApi.extender(usuario.id, horas, nota, token), `Se extendió el bloqueo de ${usuario.nombre} ${texto}.`);

  return (
    <article className={`rounded-xl border bg-white p-4 ${revisado ? 'border-neutral-200' : 'border-warning-500/50'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-neutral-900">
            {usuario.nombre} <span className="font-normal text-neutral-400">#{usuario.id}</span>
          </h3>
          <p className="text-sm text-neutral-600">
            {restanteMs > 0 ? `Se levanta sola en ${duracionTexto(restanteMs)}` : 'Se levanta en cualquier momento'} · {formatoFechaHora(activa.expiraEn)}
          </p>
        </div>
        {revisado ? <Chip tono="brand">Revisada · se mantiene</Chip> : <Chip tono="warning">Pendiente de revisión</Chip>}
      </div>
      {revisado && (
        <p className="mt-1 text-xs text-neutral-500">
          Última decisión: {revisado.por ?? 'un administrador'} el {formatoFechaHora(revisado.en)}
          {revisado.nota ? ` — «${revisado.nota}»` : ''}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {activa.casos.map((caso) => (
          <CasoBloqueo key={caso.id} caso={caso} />
        ))}
      </div>

      <div className="mt-3">
        <FichaUsuario id={usuario.id} nombre={usuario.nombre} ficha={usuario.ficha} />
      </div>

      <div className="mt-4 border-t border-neutral-100 pt-3">
        <CampoNota id={`nota-${usuario.id}`} decision={decision} />

        {decision.confirmando ? (
          <div className="mt-3 rounded-lg bg-accent-500/10 p-3">
            <p className="text-sm text-neutral-800">
              ¿Levantar ahora el bloqueo de <strong>{usuario.nombre}</strong>? Va a poder entrar de inmediato, sus productos (si vende) vuelven a mostrarse, y este mismo hallazgo no volverá a suspenderla.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="accent" onClick={liberar} disabled={decision.trabajando}>
                {decision.trabajando ? 'Levantando...' : 'Sí, levantar el bloqueo'}
              </Button>
              <Button variant="outline" onClick={() => decision.setConfirmando(false)} disabled={decision.trabajando}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="accent" onClick={() => decision.setConfirmando(true)} disabled={decision.trabajando}>
              Levantar bloqueo
            </Button>
            <Button variant="outline" onClick={() => extender(24, 'otras 24 horas')} disabled={decision.trabajando}>
              Extender 24 h
            </Button>
            <Button variant="outline" onClick={() => extender(168, '7 días más')} disabled={decision.trabajando}>
              Extender 7 días
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

// Una cuenta bajo vigilancia (hallazgo «posible», límites suaves): sigue comprando, con
// su contraseña en cada pedido y topes de monto y de pedidos por hora. La decisión que
// toma un administrador es una sola: quitarle los límites antes de que venzan solos
// (era un falso positivo). No hay "extender": si el hallazgo sube a confianza alta, el
// sistema abre una suspensión aparte.
function TarjetaRestriccion({ restringida, ahora, token, onCambio, limites }) {
  const decision = useDecision(onCambio);
  const restanteMs = new Date(restringida.expiraEn).getTime() - ahora;
  const { usuario } = restringida;

  const quitar = () =>
    decision.decidir(
      (nota) => bloqueosApi.quitarRestriccion(usuario.id, nota, token),
      `Se quitaron los límites de ${usuario.nombre}. Este hallazgo no volverá a limitarla; si más adelante sube a confianza alta, sí podría suspenderla.`
    );

  return (
    <article className="rounded-xl border border-warning-500/40 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-neutral-900">
            {usuario.nombre} <span className="font-normal text-neutral-400">#{usuario.id}</span>
          </h3>
          <p className="text-sm text-neutral-600">
            {restanteMs > 0 ? `Los límites se quitan solos en ${duracionTexto(restanteMs)}` : 'Los límites se quitan en cualquier momento'} · {formatoFechaHora(restringida.expiraEn)}
          </p>
        </div>
        <Chip tono="warning">Bajo vigilancia</Chip>
      </div>
      {limites && <p className="mt-1 text-xs text-neutral-500">Mientras tanto compra con: {descripcionLimites(limites)}.</p>}

      <div className="mt-3 flex flex-col gap-3">
        {restringida.casos.map((caso) => (
          <CasoBloqueo key={caso.id} caso={caso} />
        ))}
      </div>

      <div className="mt-3">
        <FichaUsuario id={usuario.id} nombre={usuario.nombre} ficha={usuario.ficha} />
      </div>

      <div className="mt-4 border-t border-neutral-100 pt-3">
        <CampoNota id={`nota-restriccion-${usuario.id}`} decision={decision} />

        {decision.confirmando ? (
          <div className="mt-3 rounded-lg bg-accent-500/10 p-3">
            <p className="text-sm text-neutral-800">
              ¿Quitar ahora los límites de <strong>{usuario.nombre}</strong>? Va a comprar sin restricciones y este mismo hallazgo no volverá a limitarla.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="accent" onClick={quitar} disabled={decision.trabajando}>
                {decision.trabajando ? 'Quitando...' : 'Sí, quitar los límites'}
              </Button>
              <Button variant="outline" onClick={() => decision.setConfirmando(false)} disabled={decision.trabajando}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="accent" onClick={() => decision.setConfirmando(true)} disabled={decision.trabajando}>
              Quitar límites
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

function Historial({ casos }) {
  if (casos.length === 0) return <p className="mt-3 text-sm text-neutral-500">Todavía no hay casos cerrados.</p>;
  return (
    <ul className="mt-3 divide-y divide-neutral-100">
      {casos.map((caso) => {
        const restriccion = caso.tipo === 'restriccion';
        return (
          <li key={caso.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-neutral-900">
                {caso.usuario.nombre} <span className="font-normal text-neutral-400">#{caso.usuario.id}</span>
              </span>
              <Chip tono={restriccion ? 'warning' : 'danger'}>{restriccion ? 'Bajo vigilancia' : 'Suspensión'}</Chip>
              <Chip>{caso.senalNombre}</Chip>
              {caso.estado === 'liberado' ? (
                <Chip tono="accent">{restriccion ? 'Límites quitados por un administrador' : 'Levantado por un administrador'}</Chip>
              ) : (
                <Chip>Venció sin que nadie lo levantara</Chip>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              {restriccion ? 'Bajo vigilancia desde el' : 'Suspendida el'} {formatoFechaHora(caso.creadoEn)} ·{' '}
              {caso.estado === 'liberado' && caso.revisado
                ? `${restriccion ? 'límites quitados' : 'levantada'} por ${caso.revisado.por ?? 'un administrador'} el ${formatoFechaHora(caso.revisado.en)}`
                : `venció el ${formatoFechaHora(caso.expiraEn)}`}
              {caso.revisado?.nota ? ` — «${caso.revisado.nota}»` : ''}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

// Respuesta escalonada al fraude (backend/src/services/bloqueoService.js,
// IA/PLAN-NEO4J-DETECCION-FRAUDE.md §20 y §21): un hallazgo de confianza ALTA suspende
// la cuenta (y oculta los productos de un vendedor), uno «posible» la deja bajo
// vigilancia con límites suaves. El sistema actúa solo, todo vence solo (TTL en Redis),
// y acá una PERSONA revisa cada caso antes de decidir — levantarlo si era un falso
// positivo, o extender la suspensión. Solo administrador (la ruta y los endpoints lo
// exigen).
export function AdminBloqueosPage() {
  const { token } = useAuth();
  const ahora = useAhora(30000);
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [evaluando, setEvaluando] = useState(false);
  const [actualizando, setActualizando] = useState(false);

  // Pide la lista y la guarda. No toca el estado de forma síncrona (solo en las
  // respuestas), así que el efecto de abajo puede llamarla sin disparar un render
  // extra; el spinner inicial sale de que `cargando` parte en true.
  const cargar = useCallback(
    () =>
      bloqueosApi
        .listar(token)
        .then((respuesta) => {
          setDatos(respuesta);
          setError('');
        })
        .catch((err) => setError(err.message))
        .finally(() => setCargando(false)),
    [token]
  );

  // Mientras el administrador mira la pantalla pueden llegar suspensiones nuevas:
  // además de la primera carga, se vuelve a pedir la lista cada medio minuto.
  useEffect(() => {
    cargar();
    const id = setInterval(cargar, 30000);
    return () => clearInterval(id);
  }, [cargar]);

  async function actualizar() {
    setActualizando(true);
    await cargar();
    setActualizando(false);
  }

  async function revisarAhora() {
    setEvaluando(true);
    setAviso('');
    try {
      const resultado = await bloqueosApi.evaluar(token);
      // Si alguna señal no se pudo evaluar (p. ej. Neo4j caído), "no hay cuentas
      // nuevas" podría ser falso: se avisa en vez de dar la revisión por completa.
      const incompleta = resultado.advertencias?.length > 0 ? ` Con advertencias: ${resultado.advertencias.join(' ')}` : '';
      const nuevas = [];
      if (resultado.cuentas.length > 0) nuevas.push(plural(resultado.cuentas.length, 'cuenta suspendida', 'cuentas suspendidas'));
      if (resultado.restringidas?.length > 0) nuevas.push(plural(resultado.restringidas.length, 'cuenta bajo vigilancia', 'cuentas bajo vigilancia'));
      setAviso(
        (nuevas.length > 0 ? `Revisión terminada: ${nuevas.join(' y ')} ahora.` : 'Revisión terminada: no hay cuentas nuevas para suspender ni vigilar.') + incompleta
      );
      await cargar();
    } catch (err) {
      setError(err.message);
    } finally {
      setEvaluando(false);
    }
  }

  async function alCambiar(mensaje) {
    setAviso(mensaje);
    await cargar();
  }

  const config = datos?.configuracion;
  const limites = config?.restriccion;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/admin" className="text-sm font-medium text-brand-700 hover:underline">
          ← Panel de administrador
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h1 className="text-xl font-bold text-neutral-900">Cuentas bloqueadas</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Un hallazgo de fraude de <strong>confianza alta</strong> suspende la cuenta temporalmente — y, si vende, oculta sus productos hasta que se levante —; uno de confianza{' '}
              <strong>«posible»</strong> la deja <strong>bajo vigilancia</strong>: sigue comprando, pero con límites suaves. Todo vence solo al cumplirse su tiempo; mientras tanto, una persona
              revisa cada caso y decide: <strong>levantarlo</strong> si era un falso positivo, o <strong>extender</strong> la suspensión. El detalle de cada señal está en{' '}
              <Link to="/admin/fraude" className="font-medium text-brand-700 hover:underline">
                Señales de fraude
              </Link>
              .
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={revisarAhora} disabled={evaluando}>
              {evaluando ? 'Revisando...' : 'Revisar ahora'}
            </Button>
            <Button variant="outline" onClick={actualizar} disabled={actualizando}>
              {actualizando ? 'Actualizando...' : 'Actualizar'}
            </Button>
          </div>
        </div>
      </div>

      {config && (
        <div className="flex flex-col gap-1 rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span>
              Bloqueo automático:{' '}
              <strong className={config.habilitado ? 'text-accent-700' : 'text-danger-600'}>{config.habilitado ? 'activo' : 'apagado'}</strong>
            </span>
            <span>
              Suspende por <strong>{config.horas} h</strong>
            </span>
            <span>
              Revisa cada <strong>{config.intervaloSegundos} s</strong>
            </span>
            {config.pedidosPorHora != null && (
              <span>
                Tope general: <strong>{config.pedidosPorHora > 0 ? `${plural(config.pedidosPorHora, 'pedido', 'pedidos')} por hora` : 'sin tope'}</strong>
              </span>
            )}
            <span>Un administrador nunca se suspende ni se limita.</span>
          </div>
          {limites && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span>
                Límites suaves («posible»):{' '}
                <strong className={limites.habilitado ? 'text-accent-700' : 'text-danger-600'}>{limites.habilitado ? 'activos' : 'apagados'}</strong>
              </span>
              {limites.habilitado && (
                <>
                  <span>
                    por <strong>{limites.horas} h</strong>
                  </span>
                  <span>Con: {descripcionLimites(limites)}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {aviso && (
        <p role="status" className="rounded-lg bg-accent-500/10 p-3 text-sm text-accent-700">
          {aviso}
        </p>
      )}
      {cargando && !datos && <Spinner />}
      {error && <p className="rounded-lg bg-danger-500/10 p-4 text-sm text-danger-600">{error}</p>}

      {datos && (
        <>
          {datos.advertencias?.length > 0 && (
            <div className="rounded-lg bg-warning-500/10 p-3 text-sm text-warning-500">
              {datos.advertencias.map((a, i) => (
                <p key={i}>{a}</p>
              ))}
            </div>
          )}

          <section>
            <h2 className="text-sm font-semibold text-neutral-800">
              Bloqueadas ahora · {plural(datos.resumen.activas, 'cuenta', 'cuentas')}
              {datos.resumen.pendientesDeRevision > 0 && <span className="font-normal text-warning-500"> · {plural(datos.resumen.pendientesDeRevision, 'pendiente de revisión', 'pendientes de revisión')}</span>}
            </h2>
            {datos.activas.length === 0 ? (
              <p className="mt-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-500">No hay cuentas suspendidas ahora.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {datos.activas.map((activa) => (
                  <TarjetaBloqueo key={activa.usuario.id} activa={activa} ahora={ahora} token={token} onCambio={alCambiar} />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold text-neutral-800">Bajo vigilancia · {plural(datos.resumen.restringidas ?? 0, 'cuenta', 'cuentas')}</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Cuentas con un hallazgo de confianza «posible»: no se las suspende — un «posible» puede ser un falso positivo con facilidad —, pero mientras dure compran con límites. Si era un
              falso positivo, quitá los límites antes de que venzan.
            </p>
            {!datos.restringidas || datos.restringidas.length === 0 ? (
              <p className="mt-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-500">No hay cuentas bajo vigilancia ahora.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {datos.restringidas.map((restringida) => (
                  <TarjetaRestriccion key={restringida.usuario.id} restringida={restringida} ahora={ahora} token={token} onCambio={alCambiar} limites={limites?.habilitado ? limites : null} />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-800">Historial reciente</h2>
            <p className="mt-1 text-xs text-neutral-500">Los últimos casos cerrados: los que un administrador levantó y los que vencieron solos. Un hallazgo cerrado no vuelve a actuar sobre la misma cuenta.</p>
            <Historial casos={datos.historial} />
          </section>
        </>
      )}
    </div>
  );
}
