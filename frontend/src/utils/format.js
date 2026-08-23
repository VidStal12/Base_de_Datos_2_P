const formatter = new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ' });

export function formatCurrency(value) {
  return formatter.format(Number(value ?? 0));
}
