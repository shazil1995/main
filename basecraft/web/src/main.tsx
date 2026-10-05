import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiError } from './api';
import { ToastProvider } from './components/ui';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: false, gcTime: 5 * 60_000 } },
});
createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={qc}><ToastProvider><App /></ToastProvider></QueryClientProvider></StrictMode>,
);
