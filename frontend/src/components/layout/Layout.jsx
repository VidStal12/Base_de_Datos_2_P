import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';
import { AvisoSuspension } from './AvisoSuspension';
import { AvisoServicios } from './AvisoServicios';

// El navegador conserva el desplazamiento al pasar de una página a otra dentro de la aplicación: sin esto, abrir /ofertas
// desde la mitad de la portada la mostraba a mitad de camino (o al final, si es más corta). Solo cuenta cambiar de página:
// los filtros del catálogo cambian la URL pero no la ruta, y cada pantalla maneja su propio desplazamiento. Al ir atrás o
// adelante ('POP') se deja que el navegador restaure donde estaba.
function ScrollAlInicio() {
  const { pathname } = useLocation();
  const tipo = useNavigationType();
  const anterior = useRef(pathname);

  useEffect(() => {
    if (anterior.current === pathname) return;
    anterior.current = pathname;
    if (tipo !== 'POP') window.scrollTo(0, 0);
  }, [pathname, tipo]);

  return null;
}

export function Layout() {
  return (
    <>
      <ScrollAlInicio />
      <Header />
      <AvisoSuspension />
      <AvisoServicios />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
