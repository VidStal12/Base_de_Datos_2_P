import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { productosApi, categoriasApi } from '../../api/productos';
import { ofertasApi } from '../../api/ofertas';
import { Field, Input } from '../../components/common/Input';
import { Button } from '../../components/common/Button';
import { Spinner } from '../../components/common/Spinner';

// Producto.oferta_flash guarda vigente_desde/hasta como Date (ISO al viajar
// por JSON); <input type="datetime-local"> necesita "AAAA-MM-DDTHH:mm" en
// hora LOCAL, no UTC — por eso no alcanza con .slice(0, 16) sobre el ISO.
function aDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function InlineCreate({ placeholder, onCrear }) {
  const [abierto, setAbierto] = useState(false);
  const [valor, setValor] = useState('');

  if (!abierto) {
    return (
      <button type="button" onClick={() => setAbierto(true)} className="text-left text-xs font-medium text-brand-700 hover:underline">
        + Crear nueva
      </button>
    );
  }

  return (
    <div className="flex gap-2">
      <input
        autoFocus
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-2 py-1.5 text-sm"
      />
      <button
        type="button"
        onClick={() => {
          if (!valor.trim()) return;
          onCrear(valor.trim());
          setValor('');
          setAbierto(false);
        }}
        className="rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Crear
      </button>
    </div>
  );
}

export function SellerProductFormPage() {
  const { id } = useParams();
  const modoEdicion = Boolean(id);
  const { token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const volverA = location.pathname.startsWith('/admin') ? '/admin' : '/vendedor';

  const [categorias, setCategorias] = useState([]);
  const [categoriaId, setCategoriaId] = useState('');
  const [subcategoriaId, setSubcategoriaId] = useState('');
  const [form, setForm] = useState({ nombre: '', descripcion: '', imagen_url: '', estado: 'activo', precio: '', cantidad: '' });
  const [textosIniciales, setTextosIniciales] = useState({ nombre: '', descripcion: '' });
  const [valoresAtributos, setValoresAtributos] = useState({});
  // Nombre nuevo pendiente para un atributo existente, indexado por su nombre
  // ORIGINAL (no cambia mientras se escribe, evita que el input pierda foco).
  // Separado de valoresAtributos a propósito: permite renombrar sin tocar el
  // valor ya cargado, y sin necesidad de "+ Crear nueva" + volver a tipear el
  // valor — ver ESTADO-PROYECTO.md §3.4.
  const [renombres, setRenombres] = useState({});
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  // Oferta flash — guardado propio, separado del form principal de arriba (ver
  // ENTREGA-2-PLAN.md §4.2): es un endpoint distinto (PATCH /api/ofertas/:id),
  // no tiene sentido acoplarlo al submit del producto.
  const [oferta, setOferta] = useState({ activo: false, precio_oferta: '', stock_oferta: '', vigente_desde: '', vigente_hasta: '' });
  const [guardandoOferta, setGuardandoOferta] = useState(false);
  const [errorOferta, setErrorOferta] = useState('');
  const [okOferta, setOkOferta] = useState(false);

  useEffect(() => {
    async function cargar() {
      const cats = await categoriasApi.listar();
      setCategorias(cats);

      if (modoEdicion) {
        const producto = await productosApi.obtener(id);
        setTextosIniciales({ nombre: producto.nombre, descripcion: producto.descripcion });
        setForm({
          nombre: producto.nombre,
          descripcion: producto.descripcion,
          imagen_url: producto.imagen_url || '',
          estado: producto.estado,
          precio: producto.inventario?.precio ?? '',
          cantidad: producto.inventario?.cantidad ?? '',
        });
        if (producto.subcategoria) {
          setCategoriaId(producto.subcategoria.categoria_id);
          setSubcategoriaId(producto.subcategoria.id);
        }
        const valores = {};
        (producto.atributos || []).forEach((attr) => {
          valores[attr.nombre] = attr.valor;
        });
        setValoresAtributos(valores);

        if (producto.oferta_flash) {
          setOferta({
            activo: producto.oferta_flash.activo || false,
            precio_oferta: producto.oferta_flash.precio_oferta ?? '',
            stock_oferta: producto.oferta_flash.stock_oferta ?? '',
            vigente_desde: aDatetimeLocal(producto.oferta_flash.vigente_desde),
            vigente_hasta: aDatetimeLocal(producto.oferta_flash.vigente_hasta),
          });
        }
      }
      setCargando(false);
    }
    cargar();
  }, [id, modoEdicion]);

  const categoriaActual = categorias.find((c) => String(c.id) === categoriaId);
  const subcategoriaActual = categoriaActual?.subcategorias.find((s) => String(s.id) === subcategoriaId);
  // Unión con las claves de valoresAtributos (no solo la plantilla de la
  // subcategoría): en modo edición, un producto puede tener un atributo que
  // ya no está en atributos_categoria (p. ej. si la plantilla cambió después
  // de crear el producto). Sin esto, ese atributo quedaba invisible en el
  // formulario — ni se veía ni se podía editar, solo "+ Crear nueva" (que
  // además fallaba si el nombre ya existía en atributos_definidos).
  const atributosDisponibles = Array.from(
    new Set([...(subcategoriaActual?.atributos_categoria || []), ...Object.keys(valoresAtributos)])
  );

  function actualizarCampo(campo, valor) {
    setForm((prev) => ({ ...prev, [campo]: valor }));
  }

  async function crearCategoria(nombre) {
    const nueva = await categoriasApi.crear({ categoria: nombre }, token);
    setCategorias((prev) => [...prev, { ...nueva, subcategorias: [] }]);
    setCategoriaId(String(nueva.id));
    setSubcategoriaId('');
  }

  async function crearSubcategoria(nombre) {
    const nueva = await categoriasApi.crearSubcategoria(categoriaId, { subcategoria: nombre }, token);
    setCategorias((prev) =>
      prev.map((c) =>
        String(c.id) === categoriaId
          ? { ...c, subcategorias: [...c.subcategorias, { ...nueva, atributos_categoria: [] }] }
          : c
      )
    );
    setSubcategoriaId(String(nueva.id));
  }

  function quitarAtributo(nombre) {
    setValoresAtributos((prev) => ({ ...prev, [nombre]: '' }));
    setRenombres((prev) => {
      const siguiente = { ...prev };
      delete siguiente[nombre];
      return siguiente;
    });
  }

  async function crearAtributo(nombre) {
    await categoriasApi.crearAtributo(subcategoriaId, { atributo: nombre }, token);
    setCategorias((prev) =>
      prev.map((c) => ({
        ...c,
        subcategorias: c.subcategorias.map((s) =>
          String(s.id) === subcategoriaId ? { ...s, atributos_categoria: [...s.atributos_categoria, nombre] } : s
        ),
      }))
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const atributos = atributosDisponibles
      .filter((nombre) => valoresAtributos[nombre]?.trim())
      .map((nombre) => ({ nombre: renombres[nombre]?.trim() || nombre, valor: valoresAtributos[nombre].trim() }));

    const nombresFinales = atributos.map((a) => a.nombre);
    if (new Set(nombresFinales).size !== nombresFinales.length) {
      setError('Hay dos atributos con el mismo nombre — revisá los nombres antes de guardar.');
      return;
    }

    setGuardando(true);
    try {
      if (modoEdicion) {
        await productosApi.actualizar(
          id,
          {
            ...(form.nombre !== textosIniciales.nombre && { nombre: form.nombre }),
            ...(form.descripcion !== textosIniciales.descripcion && { descripcion: form.descripcion }),
            imagen_url: form.imagen_url,
            estado: form.estado,
            precio: Number(form.precio),
            cantidad: Number(form.cantidad),
            atributos,
          },
          token
        );
      } else {
        if (!subcategoriaId) throw new Error('Elegí una categoría y subcategoría');
        await productosApi.crear(
          {
            nombre: form.nombre,
            descripcion: form.descripcion,
            imagen_url: form.imagen_url,
            estado: form.estado,
            subcategoriaId,
            precio: Number(form.precio),
            cantidad: Number(form.cantidad),
            atributos,
          },
          token
        );
      }
      navigate(volverA);
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  }

  async function guardarOferta(e) {
    e.preventDefault();
    setErrorOferta('');
    setOkOferta(false);
    setGuardandoOferta(true);
    try {
      await ofertasApi.actualizar(
        id,
        {
          activo: oferta.activo,
          precio_oferta: oferta.precio_oferta === '' ? undefined : Number(oferta.precio_oferta),
          stock_oferta: oferta.stock_oferta === '' ? undefined : Number(oferta.stock_oferta),
          vigente_desde: oferta.vigente_desde || undefined,
          vigente_hasta: oferta.vigente_hasta || undefined,
        },
        token
      );
      setOkOferta(true);
    } catch (err) {
      setErrorOferta(err.message);
    } finally {
      setGuardandoOferta(false);
    }
  }

  if (cargando) return <Spinner />;

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 text-xl font-bold text-neutral-900">{modoEdicion ? 'Editar producto' : 'Nuevo producto'}</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Nombre del producto">
          <Input required value={form.nombre} onChange={(e) => actualizarCampo('nombre', e.target.value)} />
        </Field>

        <Field label="Descripción">
          <textarea required={!modoEdicion || Boolean(textosIniciales.descripcion)} rows={4} className="rounded-lg border border-neutral-300 px-3 py-2.5 focus:border-brand-500" value={form.descripcion} onChange={(e) => actualizarCampo('descripcion', e.target.value)} />
        </Field>

        <Field label="URL de imagen">
          <Input
            type="url"
            placeholder="https://..."
            value={form.imagen_url}
            onChange={(e) => actualizarCampo('imagen_url', e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Precio (Q)">
            <Input
              type="number"
              step="0.01"
              min="0.01"
              required
              value={form.precio}
              onChange={(e) => actualizarCampo('precio', e.target.value)}
            />
          </Field>
          <Field label="Stock">
            <Input
              type="number"
              min="0"
              step="1"
              required
              value={form.cantidad}
              onChange={(e) => actualizarCampo('cantidad', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Estado">
          <select
            value={form.estado}
            onChange={(e) => actualizarCampo('estado', e.target.value)}
            className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm"
          >
            <option value="activo">Activo (visible en el catálogo)</option>
            <option value="inactivo">Inactivo (oculto)</option>
          </select>
        </Field>

        <div className="rounded-lg border border-neutral-200 p-4">
          <h2 className="mb-3 text-sm font-semibold text-neutral-800">Categoría</h2>
          {modoEdicion && (
            <p className="mb-3 text-xs text-neutral-500">
              La categoría no se puede cambiar después de creado el producto — creá uno nuevo si necesitás reclasificarlo.
            </p>
          )}
          <div className="flex flex-col gap-3">
            <Field label="Categoría">
              <select
                disabled={modoEdicion}
                value={categoriaId}
                onChange={(e) => {
                  setCategoriaId(e.target.value);
                  setSubcategoriaId('');
                }}
                className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm disabled:bg-neutral-100"
              >
                <option value="">Elegir...</option>
                {categorias.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.categoria}
                  </option>
                ))}
              </select>
            </Field>
            {!modoEdicion && <InlineCreate placeholder="Nombre de la categoría" onCrear={crearCategoria} />}

            {categoriaId && (
              <>
                <Field label="Subcategoría">
                  <select
                    disabled={modoEdicion}
                    value={subcategoriaId}
                    onChange={(e) => setSubcategoriaId(e.target.value)}
                    className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm disabled:bg-neutral-100"
                  >
                    <option value="">Elegir...</option>
                    {categoriaActual?.subcategorias.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.subcategoria}
                      </option>
                    ))}
                  </select>
                </Field>
                {!modoEdicion && <InlineCreate placeholder="Nombre de la subcategoría" onCrear={crearSubcategoria} />}
              </>
            )}
          </div>
        </div>

        {subcategoriaId && (
          <div className="rounded-lg border border-neutral-200 p-4">
            <h2 className="mb-3 text-sm font-semibold text-neutral-800">
              Atributos de {subcategoriaActual?.subcategoria}
            </h2>
            <div className="flex flex-col gap-3">
              {atributosDisponibles.map((nombre) => (
                <div key={nombre} className="flex flex-col gap-2 rounded-lg border border-neutral-100 p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <Field label="Nombre del atributo">
                        <Input
                          value={renombres[nombre] ?? nombre}
                          onChange={(e) => setRenombres((prev) => ({ ...prev, [nombre]: e.target.value }))}
                        />
                      </Field>
                    </div>
                    {valoresAtributos[nombre]?.trim() && (
                      <button
                        type="button"
                        onClick={() => quitarAtributo(nombre)}
                        className="mt-6 shrink-0 text-xs font-medium text-danger-600 hover:underline"
                      >
                        Quitar
                      </button>
                    )}
                  </div>
                  <Field label="Valor">
                    <Input
                      value={valoresAtributos[nombre] || ''}
                      onChange={(e) => setValoresAtributos((prev) => ({ ...prev, [nombre]: e.target.value }))}
                    />
                  </Field>
                </div>
              ))}
              <InlineCreate placeholder="Nombre del atributo (p. ej. Material)" onCrear={crearAtributo} />
            </div>
          </div>
        )}

        {error && <p className="text-sm text-danger-600">{error}</p>}

        <Button type="submit" variant="accent" disabled={guardando} className="py-3">
          {guardando ? 'Guardando...' : modoEdicion ? 'Guardar cambios' : 'Publicar producto'}
        </Button>
      </form>

      {/* Fuera del <form> de arriba a propósito — no se puede anidar un
          <form> dentro de otro, y esto guarda contra un endpoint aparte
          (PATCH /api/ofertas/:id), no contra POST|PATCH /api/productos. Solo
          en modo edición: una oferta necesita un productoId que ya exista. */}
      {modoEdicion && (
        <form onSubmit={guardarOferta} className="mt-8 flex flex-col gap-4 rounded-lg border border-neutral-200 p-4">
          <div>
            <h2 className="text-sm font-semibold text-neutral-800">Oferta flash</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Cupo limitado a precio rebajado, con ventana de vigencia — separado del precio y stock normales de arriba
              (ver IA/ENTREGA-2-PLAN.md §4.2).
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium text-neutral-700">
            <input
              type="checkbox"
              checked={oferta.activo}
              onChange={(e) => setOferta((prev) => ({ ...prev, activo: e.target.checked }))}
            />
            Oferta activa
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Precio de oferta (Q)">
              <Input
                type="number"
                step="0.01"
                min="0.01"
                value={oferta.precio_oferta}
                onChange={(e) => setOferta((prev) => ({ ...prev, precio_oferta: e.target.value }))}
              />
            </Field>
            <Field label="Unidades limitadas">
              <Input
                type="number"
                min="1"
                step="1"
                value={oferta.stock_oferta}
                onChange={(e) => setOferta((prev) => ({ ...prev, stock_oferta: e.target.value }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Empieza">
              <Input
                type="datetime-local"
                value={oferta.vigente_desde}
                onChange={(e) => setOferta((prev) => ({ ...prev, vigente_desde: e.target.value }))}
              />
            </Field>
            <Field label="Termina">
              <Input
                type="datetime-local"
                value={oferta.vigente_hasta}
                onChange={(e) => setOferta((prev) => ({ ...prev, vigente_hasta: e.target.value }))}
              />
            </Field>
          </div>

          {errorOferta && <p className="text-sm text-danger-600">{errorOferta}</p>}
          {okOferta && <p className="text-sm text-accent-700">Oferta guardada.</p>}

          <Button type="submit" variant="primary" disabled={guardandoOferta} className="py-2.5">
            {guardandoOferta ? 'Guardando...' : 'Guardar oferta'}
          </Button>
        </form>
      )}
    </div>
  );
}
