import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { productosApi, categoriasApi } from '../../api/productos';
import { Field, Input } from '../../components/common/Input';
import { Button } from '../../components/common/Button';
import { Spinner } from '../../components/common/Spinner';

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
  const [form, setForm] = useState({ descripcion: '', imagen_url: '', estado: 'activo', precio: '', cantidad: '' });
  const [valoresAtributos, setValoresAtributos] = useState({});
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function cargar() {
      const cats = await categoriasApi.listar();
      setCategorias(cats);

      if (modoEdicion) {
        const producto = await productosApi.obtener(id);
        setForm({
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
      }
      setCargando(false);
    }
    cargar();
  }, [id, modoEdicion]);

  const categoriaActual = categorias.find((c) => String(c.id) === categoriaId);
  const subcategoriaActual = categoriaActual?.subcategorias.find((s) => String(s.id) === subcategoriaId);
  const atributosDisponibles = subcategoriaActual?.atributos_categoria || [];

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
      .map((nombre) => ({ nombre, valor: valoresAtributos[nombre].trim() }));

    setGuardando(true);
    try {
      if (modoEdicion) {
        await productosApi.actualizar(
          id,
          {
            descripcion: form.descripcion,
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

  if (cargando) return <Spinner />;

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 text-xl font-bold text-neutral-900">{modoEdicion ? 'Editar producto' : 'Nuevo producto'}</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Descripción">
          <Input required value={form.descripcion} onChange={(e) => actualizarCampo('descripcion', e.target.value)} />
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
                <Field key={nombre} label={nombre}>
                  <Input
                    value={valoresAtributos[nombre] || ''}
                    onChange={(e) => setValoresAtributos((prev) => ({ ...prev, [nombre]: e.target.value }))}
                  />
                </Field>
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
    </div>
  );
}
