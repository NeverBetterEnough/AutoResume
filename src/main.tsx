import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/style.css';
import { installErrorCapture } from './lib/diagnostics';
installErrorCapture('sidepanel');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
