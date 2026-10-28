// Íconos en línea, del mismo estilo que los del encabezado (trazo de 2, extremos redondos). Heredan el color del texto y
// se ocultan a los lectores de pantalla: siempre acompañan a un texto o a un botón con nombre.
function Icono({ children, ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const IconoRayo = (props) => (
  <Icono {...props}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </Icono>
);

export const IconoReloj = (props) => (
  <Icono {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Icono>
);

export const IconoChevronIzq = (props) => (
  <Icono {...props}>
    <polyline points="15 18 9 12 15 6" />
  </Icono>
);

export const IconoChevronDer = (props) => (
  <Icono {...props}>
    <polyline points="9 18 15 12 9 6" />
  </Icono>
);

export const IconoPausa = (props) => (
  <Icono {...props}>
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </Icono>
);

export const IconoReproducir = (props) => (
  <Icono {...props}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </Icono>
);

export const IconoCorazon = (props) => (
  <Icono {...props}>
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </Icono>
);

export const IconoPremio = (props) => (
  <Icono {...props}>
    <circle cx="12" cy="8" r="7" />
    <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
  </Icono>
);

export const IconoCuadricula = (props) => (
  <Icono {...props}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </Icono>
);

export const IconoRefrescar = (props) => (
  <Icono {...props}>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </Icono>
);
