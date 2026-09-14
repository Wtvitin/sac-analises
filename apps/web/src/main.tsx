import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthGateway } from './AuthGateway';
import './styles.css';
import './auth.css';
import './enhancements.css';
import './responsive-overrides.css';
import './foundation.css';
import './records.css';
import './catalog.css';
import './sac-form.css';
import './notifications.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthGateway /></React.StrictMode>);
