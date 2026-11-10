import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './app/AppShell';
import { hasSeenWelcome } from './lib/prefs';
import Welcome from './pages/Welcome';
import TransferHome from './pages/TransferHome';
import SendPicker from './pages/SendPicker';
import ReceiveEntry from './pages/ReceiveEntry';
import HistoryPage from './pages/HistoryPage';
import DevicesPage from './pages/DevicesPage';
import SettingsPage from './pages/SettingsPage';
import NotFound from './pages/NotFound';

// The brand preview is a development tool only; it is not part of the production bundle.
const BrandPreview = import.meta.env.DEV ? lazy(() => import('./pages/BrandPreview')) : null;

/** First visit goes to Welcome once (PRD §5.1); every later visit opens Transfer home directly. */
function FirstVisit({ children }: { children: ReactNode }) {
  return hasSeenWelcome() ? <>{children}</> : <Navigate to="/welcome" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/welcome" element={<Welcome />} />
      <Route element={<AppShell />}>
        <Route
          index
          element={
            <FirstVisit>
              <TransferHome />
            </FirstVisit>
          }
        />
        <Route path="send" element={<SendPicker />} />
        <Route path="receive" element={<ReceiveEntry />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      {BrandPreview && (
        <Route
          path="/brand"
          element={
            <Suspense fallback={<p className="p-6 text-fg-2">Loading…</p>}>
              <BrandPreview />
            </Suspense>
          }
        />
      )}
    </Routes>
  );
}
