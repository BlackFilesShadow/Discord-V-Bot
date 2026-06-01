import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { DevSessionProvider } from './lib/devSession';
import { BotAdminSessionProvider } from './lib/botAdminSession';
import { DensityProvider } from './lib/density';
import { ToastProvider } from './lib/toast';
import { PinnedToolsProvider } from './lib/pinnedTools';
import { RecentActionsProvider } from './lib/recentActions';
import './index.css';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>
          <DevSessionProvider>
            <BotAdminSessionProvider>
            <DensityProvider>
              <PinnedToolsProvider>
                <RecentActionsProvider>
                  <ToastProvider>
                    <App />
                  </ToastProvider>
                </RecentActionsProvider>
              </PinnedToolsProvider>
            </DensityProvider>
            </BotAdminSessionProvider>
          </DevSessionProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
