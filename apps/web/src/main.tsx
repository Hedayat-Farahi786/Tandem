import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

const saved = (() => {
  try {
    return localStorage.getItem('tandem-theme');
  } catch {
    return null;
  }
})();
document.documentElement.dataset.theme = saved ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
