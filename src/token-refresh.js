/**
 * 자동 토큰 갱신 — 3일마다 DB의 모든 refresh_token을 갱신합니다.
 * refresh token은 갱신 안 하면 30일 뒤 만료됩니다.
 * 주기적으로 갱신하면 체인이 끊기지 않아 평생 유지가 가능합니다.
 */
import axios from 'axios';
import { query } from './db/index.js';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const OAUTH_PROXY_URL = process.env.OAUTH_PROXY_URL || null;

// 3일마다 실행
const INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

// 요청 사이 딜레이 (rate limit 방지)
const DELAY_MS = 800;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function refreshToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  try {
    const url = OAUTH_PROXY_URL || 'https://discord.com/api/oauth2/token';
    const res = await axios.post(url, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    return {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      expires_in: res.data.expires_in,
    };
  } catch (e) {
    return null;
  }
}

let isRefreshing = false;

export async function runTokenRefresh() {
  // 동시 실행 방지 — 이전 실행이 끝나지 않았으면 스킵
  if (isRefreshing) {
    console.warn('[TokenRefresh] 이미 실행 중, 이번 회차 스킵');
    return;
  }
  isRefreshing = true;
  console.log('[TokenRefresh] 전체 토큰 갱신 시작...');

  try {
    // refresh_token이 있는 유저만 대상
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
    let failed = 0;

    for (const user of rows) {
      const result = await refreshToken(user.refresh_token);

      if (result) {
        const newExpiry = new Date(Date.now() + result.expires_in * 1000);
        try {
          await query(
            'UPDATE verified_users SET access_token=$1, refresh_token=$2, token_expires_at=$3 WHERE id=$4',
            [result.access_token, result.refresh_token, newExpiry.toISOString(), user.id],
          );
          success++;
        } catch (err) {
          console.error(`[TokenRefresh] DB 업데이트 실패 (user ${user.user_id}):`, err.message);
          failed++;
        }
      } else {
        // 갱신 실패 = refresh token 자체가 만료됨 (유저가 앱 권한 해제 등)
        // 토큰 null 처리해서 재인증 필요 상태로 표시
        try {
          await query(
            'UPDATE verified_users SET access_token=NULL, refresh_token=NULL, token_expires_at=NULL WHERE id=$1',
            [user.id],
          );
        } catch {}
        failed++;
      }

      await sleep(DELAY_MS);
    }

    console.log(`[TokenRefresh] 완료 — 성공: ${success}명, 실패(재인증 필요): ${failed}명`);
  } finally {
    // 예외 발생 시에도 반드시 플래그 해제
    isRefreshing = false;
  }
}

export function startTokenRefreshScheduler() {
  // 서버 시작 1분 뒤 첫 실행 (DB 연결 안정화 대기)
  setTimeout(() => {
    runTokenRefresh();
    // 이후 3일마다 반복
    setInterval(runTokenRefresh, INTERVAL_MS);
  }, 60 * 1000);

  console.log('[TokenRefresh] 스케줄러 등록 완료 (3일 주기)');
}
