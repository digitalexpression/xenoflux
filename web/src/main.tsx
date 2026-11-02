import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { applyStoredTheme } from './lib/theme';

applyStoredTheme();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
