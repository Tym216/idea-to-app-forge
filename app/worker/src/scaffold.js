/**
 * 生成应用的基础脚手架(Vite + React + TS)。
 * LLM 只需生成业务文件,避免每次重复生成构建配置,降低出错率。
 */
export const SCAFFOLD_FILES = {
  'package.json': JSON.stringify(
    {
      name: 'generated-app',
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite --host 0.0.0.0 --port 5173',
        build: 'vite build',
        preview: 'vite preview --host 0.0.0.0 --port 5173',
      },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.1',
        typescript: '^5.5.4',
        vite: '^5.4.2',
        '@types/react': '^18.3.5',
        '@types/react-dom': '^18.3.0',
      },
    },
    null,
    2
  ),
  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
});
`,
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: false,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        isolatedModules: true,
      },
      include: ['src'],
    },
    null,
    2
  ),
  'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'src/main.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './design-tokens.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
  'src/index.css': `:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; }
`,
  'src/App.tsx': `export default function App() {
  return <main style={{ padding: 24 }}>Loading…</main>;
}
`,
};

/** 允许模型改写的文件(脚手架中的构建配置默认保护,除非模型明确需要)。 */
export const PROTECTED_PATHS = new Set(['vite.config.ts', 'tsconfig.json']);
