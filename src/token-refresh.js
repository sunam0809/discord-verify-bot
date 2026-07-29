/**
 * 자동 토큰 갱신
 * - 1일마다 전체 갱신 (Discord refresh token은 30일 미사용 시 만료)
 * - 네트워크/서버 오류는 최대 3회 재시도 후 스킵 (토큰을 null 처리하지 않음)
 * - Discord가 invalid_grant 반환 시에만 토큰 null 처리 (유저가 앱 권한 해제한 경우)
 * - 이 방식으로 봇이 계속 실행되는 한 이론상 영구 유효
 */
import axios from 'axios';
import { query } from './db/index.js';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const OAUTH_PROXY_URL = process.env.OAUTH_PROXY_URL || null;

// 1일마다 실행 (30일 만료 대비 충분한 여유)
const INTERVAL_MS = 4 * 60 * 60 * 1000;

// 요청 사이 딜레이 (rate limit 방지)
const DELAY_MS = 800;

// 갱신 실패 시 재시도 횟수 (네트워크 오류 등 일시적 장애)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000; // 30초

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * refresh_token으로 새 토큰 발급
 * @returns {{ access_token, refresh_token, expires_in }} | null (invalid_grant — 재인증 필요) | 'retry' (일시적 오류)
 */
async function refreshToken(rt, attempt = 0) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: rt,
  });

  try {
    const url = OAUTH_PROXY_URL || 'https://discord.com/api/oauth2/token';
    const res = await axios.post(url, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 12000,
    });
    return {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      expires_in: res.data.expires_in,
    };
  } catch (e) {
    const status = e.response?.status;
    const errorCode = e.response?.data?.error;

    // invalid_grant = 유저가 앱 권한을 해제했거나 토큰이 완전히 만료됨 → 재인증 필요
    if (status === 400 && errorCode === 'invalid_grant') {
      return null;
    }

    // 401 unauthorized도 토큰 무효
    if (status === 401) {
      return null;
    }

    // 그 외 (네트워크 오류, 5xx, 429 등) → 재시도 가능
    if (attempt < MAX_RETRIES - 1) {
      console.warn(`[TokenRefresh] 일시적 오류 (status: ${status}, attempt ${attempt + 1}/${MAX_RETRIES}), ${RETRY_DELAY_MS / 1000}초 후 재시도...`);
      await sleep(RETRY_DELAY_MS);
      return refreshToken(rt, attempt + 1);
    }

    // 재시도 모두 소진 → 이번 주기 스킵 (토큰은 유지)
    console.error(`[TokenRefresh] 재시도 소진 (status: ${status}, error: ${errorCode}) — 토큰 유지, 다음 주기에 재시도`);
    return 'retry';
  }
}

let isRefreshing = false;

export async function runTokenRefresh() {
  if (isRefreshing) {
    console.warn('[TokenRefresh] 이미 실행 중, 이번 회차 스킵');
    return;
  }
  isRefreshing = true;
  console.log('[TokenRefresh] 전체 토큰 갱신 시작...');

  try {
    let rows;
    try {
      const res = await query(
        'SELECT id, user_id, refresh_token FROM verified_users WHERE refresh_token IS NOT NULL',
      );
      rows = res.rows;
    } catch (err) {
      console.error('[TokenRefresh] DB 조회 실패:', err.message);
      return;
    }

    console.log(`[TokenRefresh] 대상 유저: ${rows.length}명`);

    let success = 0;
    let skipped = 0; // 일시적 오류로 이번 주기 스킵
    let revoked = 0; // invalid_grant (재인증 필요)

    for (const user of rows) {
      const result = await refreshToken(user.refresh_token);

      if (result === 'retry') {
        // 일시적 오류 — 토큰 그대로 유지
        skipped++;
      } else if (result === null) {
        // 완전히 만료 또는 유저가 앱 해제 → null 처리
        try {
          await query(
            'UPDATE verified_users SET access_token=NULL, refresh_token=NULL, token_expires_at=NULL WHERE id=$1',
            [user.id],
          );
        } catch {}
        revoked++;
      } else {
        // 갱신 성공
        const newExpiry = new Date(Date.now() + result.expires_in * 1000);
        try {
          await query(
            'UPDATE verified_users SET access_token=$1, refresh_token=$2, token_expires_at=$3 WHERE id=$4',
            [result.access_token, result.refresh_token, newExpiry.toISOString(), user.id],
          );
          success++;
        } catch (err) {
          console.error(`[TokenRefresh] DB 업데이트 실패 (user ${user.user_id}):`, err.message);
          skipped++;
        }
      }

      await sleep(DELAY_MS);
    }

    console.log(
      `[TokenRefresh] 완료 — 성공: ${success}명, 임시스킵: ${skipped}명, 재인증필요(앱해제): ${revoked}명`,
    );
  } finally {
    isRefreshing = false;
  }
}

export function startTokenRefreshScheduler() {
  // 서버 시작 2분 뒤 첫 실행 (DB 연결 안정화 대기)
  setTimeout(() => {
    runTokenRefresh();
    setInterval(runTokenRefresh, INTERVAL_MS);
  }, 2 * 60 * 1000);

  console.log('[TokenRefresh] 스케줄러 등록 완료 (4시간 주기)');
}
