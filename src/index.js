import { initDB } from './db/index.js';
import app from './web/app.js';
import axios from 'axios';
import { startTokenRefreshScheduler } from './token-refresh.js';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// 인메모리 로그 버퍼 (최근 200줄)
const logBuffer = [];
function pushLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
}
const _err = console.error.bind(console);
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
console.error = (...a) => { _err(...a); pushLog('ERR', ...a); };
console.log = (...a) => { _log(...a); pushLog('LOG', ...a); };
console.warn = (...a) => { _warn(...a); pushLog('WRN', ...a); };

global._logBuffer = logBuffer;

process.on('uncaughtException', (err) => console.error('[Process] Uncaught:', err.message, err.stack));
process.on('unhandledRejection', (reason) => console.error('[Process] Rejection:', String(reason)));

app.get('/bot-status', (req, res) => {
  res.json({ mode: 'http-interactions', status: 'online' });
});

app.get('/debug-log', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send((global._logBuffer || []).join('\n') || '(no logs yet)');
});

async function selfPing() {
  try { await axios.get(`${BASE_URL}/health`, { timeout: 8000 }); }
  catch (e) { console.warn('[Ping] Failed:', e.message); }
}

async function main() {
  console.log('[Main] Starting HTTP Interactions mode...');
  // 서버 먼저 시작 (Render 헬스체크 즉시 통과)
  await new Promise(resolve => app.listen(PORT, () => {
    console.log(`[Web] Listening on port ${PORT}`);
    resolve();
  }));
  // DB는 서버 시작 후 연결
  await initDB();
  console.log('[DB] Connected');
  startTokenRefreshScheduler();
  setInterval(selfPing, 60 * 1000);
  setTimeout(selfPing, 5000);
}

main().catch(err => { console.error('[Main] Fatal:', err.message); process.exit(1); });
