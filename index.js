import { startCharonsol } from './src/app.js';

startCharonsol().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
