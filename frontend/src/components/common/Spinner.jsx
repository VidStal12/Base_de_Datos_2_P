export function Spinner({ className = '' }) {
  return (
    <div className={`flex items-center justify-center py-12 ${className}`}>
      <div className="size-8 animate-spin rounded-full border-4 border-neutral-200 border-t-brand-500" />
    </div>
  );
}
