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
import JoinLinkPage from './pages/receive/JoinLinkPage';
import JoinPreviewPage from './pages/receive/JoinPreviewPage';
import { flags } from './config/flags';

// The brand preview is a development tool only; it is not part of the production bundle.
// Session and transfer screens (and the transfer engine they pull in) load on demand.
const SessionPage = lazy(() => import('./pages/send/SessionPage'));
const TransferDashboard = lazy(() => import('./pages/send/TransferDashboard'));
const ReceiveSessionPage = lazy(() => import('./pages/receive/ReceiveSessionPage'));
const SaveLocationPage = lazy(() => import('./pages/receive/SaveLocationPage'));

const BrandPreview = import.meta.env.DEV ? lazy(() => import('./pages/BrandPreview')) : null;

/** First visit goes to Welcome once (PRD §5.1); every later visit opens Transfer home directly. */
function FirstVisit({ children }: { children: ReactNode }) {
  return hasSeenWelcome() ? <>{children}</> : <Navigate to="/welcome" replace />;
}

function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div aria-hidden className="mx-auto h-[240px] w-full max-w-[680px] animate-pulse rounded-[16px] bg-surface-2" />
      }
    >
      {children}
    </Suspense>
  );
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
        {flags.sharing && (
          <>
            <Route
              path="send/session/:id"
              element={
                <Lazy>
                  <SessionPage />
                </Lazy>
              }
            />
            <Route path="j/:token" element={<JoinLinkPage />} />
            <Route path="join/preview" element={<JoinPreviewPage />} />
            <Route
              path="receive/:sessionId"
              element={
                <Lazy>
                  <ReceiveSessionPage />
                </Lazy>
              }
            />
            <Route
              path="receive/:sessionId/save"
              element={
                <Lazy>
                  <SaveLocationPage />
                </Lazy>
              }
            />
            <Route
              path="send/session/:id/transfers"
              element={
                <Lazy>
                  <TransferDashboard />
                </Lazy>
              }
            />
            <Route
              path="send/session/:id/result"
              element={
                <Lazy>
                  <TransferDashboard />
                </Lazy>
              }
            />
          </>
        )}
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
