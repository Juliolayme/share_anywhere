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

// Account screens (Phase 5A, `accounts` flag) and the key library they use load on demand.
const SignInPage = lazy(() => import('./pages/account/SignInPage'));
const ResetPage = lazy(() => import('./pages/account/ResetPage'));
const ChoicesPage = lazy(() => import('./pages/account/ChoicesPage'));
const KeySetupPage = lazy(() => import('./pages/account/KeySetupPage'));
const PairPage = lazy(() => import('./pages/account/PairPage'));
const ChecklistPage = lazy(() => import('./pages/account/ChecklistPage'));

// Clipboard Sync (Phase 5B, `clipboard` flag): CB-1…CB-5 and CB-6 load on demand (docs/UX_SCREEN_MAP.md §10).
const ClipboardPage = lazy(() => import('./pages/ClipboardPage'));
const ClipboardSettingsPage = lazy(() => import('./pages/ClipboardSettingsPage'));
const clipboardOn = flags.clipboard && flags.accounts;

const BrandPreview = import.meta.env.DEV ? lazy(() => import('./pages/BrandPreview')) : null;

/** First visit goes to Welcome once (PRD §5.1); every later visit opens Transfer home directly. */
function FirstVisit({ children }: { children: ReactNode }) {
  return hasSeenWelcome() ? <>{children}</> : <Navigate to="/welcome" replace />;
}

/** Account routes outside the app shell (docs/UX_SCREEN_MAP.md §9). */
function AuthLazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-bg">
          <div aria-hidden className="h-[320px] w-full max-w-[440px] animate-pulse rounded-xl bg-surface-2" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
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
      {flags.accounts && (
        <>
          <Route
            path="/signin"
            element={
              <AuthLazy>
                <SignInPage mode="signin" />
              </AuthLazy>
            }
          />
          <Route
            path="/signup"
            element={
              <AuthLazy>
                <SignInPage mode="signup" />
              </AuthLazy>
            }
          />
          <Route
            path="/reset"
            element={
              <AuthLazy>
                <ResetPage />
              </AuthLazy>
            }
          />
          <Route
            path="/signin/choices"
            element={
              <AuthLazy>
                <ChoicesPage />
              </AuthLazy>
            }
          />
          <Route
            path="/account/key/setup"
            element={
              <AuthLazy>
                <KeySetupPage />
              </AuthLazy>
            }
          />
          <Route
            path="/account/key/pair"
            element={
              <AuthLazy>
                <PairPage />
              </AuthLazy>
            }
          />
          <Route
            path="/account/checklist"
            element={
              <AuthLazy>
                <ChecklistPage />
              </AuthLazy>
            }
          />
        </>
      )}
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
        {/* HI-1 list and HI-2 detail (/history/:entryId) share one page so filters survive opening an entry. */}
        <Route path="history/*" element={<HistoryPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        {clipboardOn && (
          <>
            {/* CB-1…CB-4 at /clipboard and the CB-5 drawer at /clipboard/:eventId share one page. */}
            <Route
              path="clipboard/*"
              element={
                <Lazy>
                  <ClipboardPage />
                </Lazy>
              }
            />
            <Route
              path="settings/clipboard"
              element={
                <Lazy>
                  <ClipboardSettingsPage />
                </Lazy>
              }
            />
          </>
        )}
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
