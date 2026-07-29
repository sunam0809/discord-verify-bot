import { initDB } from './db/index.js';
import app from './web/app.js';
import { startTokenRefreshScheduler } from './token-refresh.js';

const PORT    = process.env.PORT    || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// 인메모리 로그 버퍼 (최근 300줄)
const logBuffer = [];
function pushLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > 300) logBuffer.shift();
}
const _err = console.error.bind(console);
const _log  = console.log.bind(console);
const _warn = console.warn.bind(console);
console.error = (...a) => { _err(...a);  pushLog('ERR', ...a); };
console.log   = (...a) => { _log(...a);  pushLog('LOG', ...a); };
console.warn  = (...a) => { _warn(...a); pushLog('WRN', ...a); };
global._logBuffer = logBuffer;

process.on('uncaughtException',  (err)    => console.error('[Process] Uncaught:', err.message || err, err.stack));
process.on('unhandledRejection', (reason) => console.error('[Process] Rejection:', String(reason)));

// SIGTERM 핸들러 — Render 배포 교체 시 graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Process] SIGTERM — graceful shutdown (10s)');
  setTimeout(() => process.exit(0), 10_000);
});

app.get('/bot-status', (req, res) => {
  res.json({ mode: 'http-interactions', status: 'online', dbReady: global._dbReady === true });
});

app.get('/debug-log', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send((global._logBuffer || []).join('\n') || '(no logs yet)');
});

// DB 연결 백그라운드 재시도 — 절대 process.exit 하지 않음
// Render health check 통과 후 조용히 DB 연결을 기다림
async function connectDBWithBackoff() {
  const DELAYS = [2, 5, 10, 20, 30, 60]; // seconds
  for (let i = 0; ; i++) {
    try {
      await initDB();
      global._dbReady = true;
      console.log('[DB] Connected OK');
      startTokenRefreshScheduler();
      return;
    } catch (err) {
      const msg = err?.message || err?.code || JSON.stringify(err) || '(unknown)';
      const delay = DELAYS[Math.min(i, DELAYS.length - 1)];
      console.error(`[DB] 연결 실패 (시도 ${i + 1}), ${delay}s 후 재시도: ${msg}`);
      await new Promise(r => setTimeout(r, delay * 1000));
    }
  }
}

async function main() {
  console.log('[Main] Starting...');
  console.log('[Main] NODE_ENV:', process.env.NODE_ENV);
  console.log('[Main] DATABASE_URL set:', !!process.env.DATABASE_URL);

  // 서버 먼저 시작 — Render 헬스체크가 즉시 통과해야 배포 성공
  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Web] Listening on port ${PORT}`);
      resolve();
    });
    server.on('error', reject);
  });

  // DB 연결은 백그라운드에서 — 실패해도 서버는 절대 종료하지 않음
  connectDBWithBackoff();
}

main().catch(err => {
  // listen 자체 실패 시에만 종료 (포트 충돌 등)
  console.error('[Main] Fatal listen error:', err.message || err);
  process.exit(1);
});
