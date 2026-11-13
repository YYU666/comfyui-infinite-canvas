import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { reportUiReady } from './ui-ready';

reportUiReady();
createRoot(document.getElementById('root')).render(<App />);
