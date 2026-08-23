import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { CartProvider } from './context/CartContext';
import { Layout } from './components/layout/Layout';
import { RequireAuth } from './components/common/RequireAuth';
import { RequireRole } from './components/common/RequireRole';
import { HomePage } from './pages/HomePage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { CartPage } from './pages/CartPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { OrderHistoryPage } from './pages/OrderHistoryPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { SellerDashboardPage } from './pages/seller/SellerDashboardPage';
import { SellerProductFormPage } from './pages/seller/SellerProductFormPage';
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage';
import { NotFoundPage } from './pages/NotFoundPage';

const ROLES_VENDEDOR = ['vendedor', 'administrador'];
const ROLES_ADMIN = ['administrador'];

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CartProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="productos/:id" element={<ProductDetailPage />} />
              <Route path="carrito" element={<CartPage />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="registro" element={<RegisterPage />} />
              <Route
                path="checkout"
                element={
                  <RequireAuth>
                    <CheckoutPage />
                  </RequireAuth>
                }
              />
              <Route
                path="pedidos"
                element={
                  <RequireAuth>
                    <OrderHistoryPage />
                  </RequireAuth>
                }
              />
              <Route
                path="pedidos/:id"
                element={
                  <RequireAuth>
                    <OrderDetailPage />
                  </RequireAuth>
                }
              />
              <Route
                path="vendedor"
                element={
                  <RequireRole roles={ROLES_VENDEDOR}>
                    <SellerDashboardPage />
                  </RequireRole>
                }
              />
              <Route
                path="vendedor/productos/nuevo"
                element={
                  <RequireRole roles={ROLES_VENDEDOR}>
                    <SellerProductFormPage />
                  </RequireRole>
                }
              />
              <Route
                path="vendedor/productos/:id/editar"
                element={
                  <RequireRole roles={ROLES_VENDEDOR}>
                    <SellerProductFormPage />
                  </RequireRole>
                }
              />
              <Route
                path="admin"
                element={
                  <RequireRole roles={ROLES_ADMIN}>
                    <AdminDashboardPage />
                  </RequireRole>
                }
              />
              <Route
                path="admin/productos/nuevo"
                element={
                  <RequireRole roles={ROLES_ADMIN}>
                    <SellerProductFormPage />
                  </RequireRole>
                }
              />
              <Route
                path="admin/productos/:id/editar"
                element={
                  <RequireRole roles={ROLES_ADMIN}>
                    <SellerProductFormPage />
                  </RequireRole>
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
