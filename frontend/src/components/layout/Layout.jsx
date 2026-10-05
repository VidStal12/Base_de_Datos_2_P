import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';
import { AvisoSuspension } from './AvisoSuspension';

export function Layout() {
  return (
    <>
      <Header />
      <AvisoSuspension />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
