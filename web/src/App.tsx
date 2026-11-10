import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ScaffoldHome } from './pages/ScaffoldHome';

// The brand preview is a development tool only; it is not part of the production bundle.
const BrandPreview = import.meta.env.DEV ? lazy(() => import('./pages/BrandPreview')) : null;

export function App() {
  return (
    <Routes>
      <Route path="/" element={<ScaffoldHome />} />
      {BrandPreview && (
        <Route
          path="/brand"
          element={
            <Suspense fallback={<p className="p-6 text-text-muted">Loading…</p>}>
              <BrandPreview />
            </Suspense>
          }
        />
      )}
      <Route path="*" element={<ScaffoldHome />} />
    </Routes>
  );
}
