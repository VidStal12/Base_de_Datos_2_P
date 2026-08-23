const VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600',
  accent: 'bg-accent-500 text-white hover:bg-accent-600 focus-visible:outline-accent-600',
  outline: 'border border-neutral-300 text-neutral-800 bg-white hover:bg-neutral-50 focus-visible:outline-brand-500',
  ghost: 'text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-500',
  danger: 'bg-white text-danger-600 border border-danger-500 hover:bg-danger-500 hover:text-white focus-visible:outline-danger-500',
};

export function Button({ variant = 'primary', className = '', as: Component = 'button', ...props }) {
  return (
    <Component
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold
        transition-colors disabled:cursor-not-allowed disabled:opacity-50
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
