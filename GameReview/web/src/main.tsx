import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/report.css';
import './styles/liveviz.css';
import './styles/print.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载节点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
