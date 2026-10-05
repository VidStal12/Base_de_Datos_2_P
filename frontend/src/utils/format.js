const formatter = new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ' });

export function formatCurrency(value) {
  return formatter.format(Number(value ?? 0));
}

// Quetzales como los muestran los paneles de administrador: "Q1,234.50".
export const formatoQ = (n) => `Q${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function diasATexto(dias) {
  if (dias < 1) return 'hoy';
  if (dias === 1) return 'hace 1 día';
  return `hace ${dias} días`;
}
