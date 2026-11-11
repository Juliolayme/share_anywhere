import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyTheme, getThemePreference } from './lib/theme';
import { I18nProvider } from './i18n/i18n';
import { IdentityProvider } from './lib/identity/identity';
import { HistoryProvider } from './features/history/HistoryContext';
import { ToastProvider } from './components/Toast';
import { SharingProvider } from './features/sharing/SharingContext';
import { KeepAwakeProvider } from './lib/keepAwake/KeepAwakeContext';
import { AccountProvider } from './features/account/AccountContext';
import { ClipboardProvider } from './features/clipboard/ClipboardContext';
import './index.css';

applyTheme(getThemePreference());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <IdentityProvider>
        <SharingProvider>
          <KeepAwakeProvider>
            <HistoryProvider>
              <AccountProvider>
                <ToastProvider>
                  <BrowserRouter>
                    <ClipboardProvider>
                      <App />
                    </ClipboardProvider>
                  </BrowserRouter>
                </ToastProvider>
              </AccountProvider>
            </HistoryProvider>
          </KeepAwakeProvider>
        </SharingProvider>
      </IdentityProvider>
    </I18nProvider>
  </StrictMode>,
);
