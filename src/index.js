import { initDB } from './db/index.js';
import app from './web/app.js';
import axios from 'axios';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

process.on('uncaughtException', (err) => console.error('[Process] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Process] Rejection:', reason));

app.get('/bot-status', (req, res) => {
  res.json({ mode: 'http-interactions', status: 'online' });
});

async function selfPing() {
  try { await axios.get(`${BASE_URL}/health`, { timeout: 8000 }); }
  catch (e) { console.warn('[Ping] Failed:', e.message); }
}

async function main() {
  console.log('[Main] Starting (HTTP Interactions mode)...');
  await initDB();
  console.log('[DB] OK');
  app.listen(PORT, () => console.log(`[Web] Port ${PORT}`));
  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
  console.log(`[Ping] Self-ping → ${BASE_URL}/health every 60s`);
}

main().catch(err => { console.error('[Main] Fatal:', err); process.exit(1); });
