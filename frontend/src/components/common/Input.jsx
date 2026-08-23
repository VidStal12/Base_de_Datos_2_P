export function Field({ label, error, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-neutral-700">{label}</span>
      {children}
      {error && <span className="text-xs text-danger-600">{error}</span>}
    </label>
  );
}

export function Input(props) {
  return (
    <input
      {...props}
      className="rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
    />
  );
}
