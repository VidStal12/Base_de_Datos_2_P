import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="mt-auto bg-brand-900 text-neutral-300">
      <div className="mx-auto max-w-7xl px-4 py-8 text-sm">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div>
            <h3 className="mb-2 font-semibold text-white">TiendaYa</h3>
            <p className="text-neutral-400">Proyecto de curso — Bases de Datos 2</p>
          </div>
          <div>
            <h3 className="mb-2 font-semibold text-white">Cuenta</h3>
            <ul className="space-y-1 text-neutral-400">
              <li>
                <Link to="/pedidos" className="hover:text-white hover:underline">
                  Mis pedidos
                </Link>
              </li>
              <li>
                <Link to="/cuenta" className="hover:text-white hover:underline">
                  Direcciones
                </Link>
              </li>
              <li>
                <Link to="/cuenta" className="hover:text-white hover:underline">
                  Métodos de pago
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-semibold text-white">Ayuda</h3>
            <ul className="space-y-1 text-neutral-400">
              <li>Preguntas frecuentes</li>
              <li>Devoluciones</li>
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-semibold text-white">TiendaYa</h3>
            <ul className="space-y-1 text-neutral-400">
              <li>Vender en TiendaYa</li>
              <li>Sobre el proyecto</li>
              <li>
                <Link to="/terminos" className="hover:text-white hover:underline">
                  Términos de Servicio
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-6 border-t border-brand-700 pt-4 text-center text-neutral-500">
          Fase Inicial · TiendaYa
        </div>
      </div>
    </footer>
  );
}
