import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

function initializeApp() {
  // Prerendered blog pages are served as pure static HTML for SEO.
  if (
    document
      .querySelector('meta[name="prerender-static-page"]')
      ?.getAttribute('content') === 'blog'
  ) {
    return;
  }
  // 主流程直接连接 Supabase,不再请求 localhost:8000/api/config。
  createRoot(document.getElementById('root')!).render(<App />);
}

initializeApp();
