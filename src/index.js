import { initDB } from './db/index.js';
import app from './web/app.js';
import { startTokenRefreshScheduler } from './token-refresh.js';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// 인메모리 로그 버퍼 (최근 300줄)
const logBuffer = [];
function pushLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > 300) logBuffer.shift();
}
const _err = console.error.bind(console);
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
console.error = (...a) => { _err(...a); pushLog('ERR', ...a); };
console.log  = (...a) => { _log(...a);  pushLog('LOG', ...a); };
console.warn = (...a) => { _warn(...a); pushLog('WRN', ...a); };
global._logBuffer = logBuffer;

process.on('uncaughtException',  (err)    => console.error('[Process] Uncaught:', err.message, err.stack));
process.on('unhandledRejection', (reason) => console.error('[Process] Rejection:', String(reason)));

// SIGTERM 핸들러 — Render 배포 교체 시 graceful shutdown
let isShuttingDown = false;
process.on('SIGTERM', () => {
  console.log('[Process] SIGTERM 수신 — graceful shutdown');
  isShuttingDown = true;
  // 10초 후 강제 종료 (연결 정리 대기)
  setTimeout(() => process.exit(0), 10_000);
});

app.get('/bot-status', (req, res) => {
  res.json({ mode: 'http-interactions', status: 'online', dbReady: global._dbReady === true });
});

app.get('/debug-log', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send((global._logBuffer || []).join('\n') || '(no logs yet)');
});

// DB 연결 재시도 (최대 5회, 3초 간격)
async function initDBWithRetry(maxAttempts = 5) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await initDB();
      global._dbReady = true;
      return;
    } catch (err) {
      console.error(`[DB] 연결 실패 (시도 ${i}/${maxAttempts}):`, err.message);
      if (i < maxAttempts) {
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  console.log('[Main] Starting HTTP Interactions mode...');

  // 서버 먼저 시작 — Render 헬스체크가 즉시 통과해야 배포 성공
  await new Promise(resolve => app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Web] Listening on port ${PORT}`);
    resolve();
  }));

  // DB 연결은 서버 시작 후 재시도 (연결 풀 경합 대비)
  await initDBWithRetry();
  console.log('[DB] Connected');

  startTokenRefreshScheduler();
}

main().catch(err => {
  console.error('[Main] Fatal:', err.message, err.stack);
  process.exit(1);
});
