// Lectura del catálogo anterior y de sus eventos inmutables: el único texto era el título.
function textosProducto(doc) {
  return doc.nombre == null
    ? { nombre: doc.descripcion ?? '', descripcion: '' }
    : { nombre: doc.nombre, descripcion: doc.descripcion ?? '' };
}
function textosParaGrafo(producto) {
  const { nombre, descripcion } = textosProducto(producto);
  return { productoNombre: nombre, productoDescripcion: descripcion };
}

module.exports = { textosProducto, textosParaGrafo };
