import React from 'react';
import { createRoot } from 'react-dom/client';
import PaintCompanionApp from './PaintCompanionApp.jsx';
import './paint.css';

createRoot(document.getElementById('companion')).render(<PaintCompanionApp />);
