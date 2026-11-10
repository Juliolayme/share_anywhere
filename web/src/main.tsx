import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyTheme, getThemePreference } from './lib/theme';
import { I18nProvider } from './i18n/i18n';
import { IdentityProvider } from './lib/identity/identity';
import { HistoryProvider } from './features/history/HistoryContext';
import { ToastProvider } from './components/Toast';
import './index.css';

applyTheme(getThemePreference());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <IdentityProvider>
        <HistoryProvider>
          <ToastProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ToastProvider>
        </HistoryProvider>
      </IdentityProvider>
    </I18nProvider>
  </StrictMode>,
);
