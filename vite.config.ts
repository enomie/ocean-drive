import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 9292, strictPort: true, host: true },
});
