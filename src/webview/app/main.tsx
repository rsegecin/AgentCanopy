import './zod-config';
import '@vscode/codicons/dist/codicon.css';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppContext } from './context';
import { createVsCodeHost } from './host';
import { createServices } from './services';

const container = document.getElementById('root');
if (container) {
  const services = createServices(createVsCodeHost());
  createRoot(container).render(
    <StrictMode>
      <AppContext.Provider value={services}>
        <App />
      </AppContext.Provider>
    </StrictMode>,
  );
  // Start after the first render is scheduled; the host answers `ready` with the full state.
  services.store.start();
}
