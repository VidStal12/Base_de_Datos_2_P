// Prueba HTTP con una cuenta sintética; no realiza compras ni modifica carritos ajenos.
require('dotenv').config({ quiet: true });
const base = process.env.VERIFICAR_API_URL || `http://localhost:${process.env.PORT || 3000}/api`;
const correo = 'diagnostico.carrito@example.com';
const contrasena = 'Password123!';

async function pedir(ruta, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${ruta}`, { method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const datos = await res.json().catch(() => null);
  return { status: res.status, datos };
}

async function main() {
  let sesion = await pedir('/auth/login', { method: 'POST', body: { correo, contrasena } });
  if (sesion.status === 401) {
    const registro = await pedir('/auth/registro', { method: 'POST', body: {
      nombres: 'Diagnóstico', apellidos: 'Carrito', correo, contrasena, fecha_nacimiento: '2000-01-01',
    } });
    if (registro.status !== 201) throw new Error(`Registro sintético: ${registro.status} ${JSON.stringify(registro.datos)}`);
    sesion = await pedir('/auth/login', { method: 'POST', body: { correo, contrasena } });
  }
  const token = sesion.datos?.token;
  if (sesion.status !== 200 || !token) throw new Error(`Login sintético: ${sesion.status} ${JSON.stringify(sesion.datos?.error)}`);
  const catalogo = await pedir('/productos');
  const producto = catalogo.datos?.find((p) => p.inventario?.cantidad > 0);
  if (!producto) throw new Error('No hay productos con stock para verificar');
  const antes = await pedir('/carrito/revisar', { method: 'POST', token });
  console.log('Carrito inicial:', JSON.stringify(antes));
  if (antes.status !== 200) throw new Error('No se pudo revisar el carrito sintético');
  const anterior = antes.datos.items.find((i) => i.producto.id === producto.id)?.cantidad || 0;
  try {
    const alta = await pedir('/carrito/items', { method: 'POST', token, body: { productoId: producto.id, cantidad: 1 } });
    console.log('Añadir:', JSON.stringify(alta));
    if (alta.status !== 201 || !alta.datos.items.some((i) => i.producto.id === producto.id && i.cantidad > anterior)) {
      throw new Error('No se añadió el producto al carrito');
    }
    console.log('APROBADO: la API añadió el producto con la cuenta sintética.');
  } finally {
    const restaurado = await pedir(`/carrito/items/${producto.id}`, { token,
      method: anterior ? 'PATCH' : 'DELETE', ...(anterior ? { body: { cantidad: anterior } } : {}) });
    console.log('Restaurar carrito sintético:', restaurado.status);
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
