import { Link } from 'react-router-dom';
import { Button } from '../components/common/Button';

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h1 className="text-4xl font-bold text-neutral-900">404</h1>
      <p className="text-neutral-600">No encontramos esta página.</p>
      <Button as={Link} to="/" variant="primary">
        Volver al catálogo
      </Button>
    </div>
  );
}
