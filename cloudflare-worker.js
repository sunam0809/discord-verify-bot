/**
 * Cloudflare Worker — Discord OAuth 토큰 교환 프록시
 *
 * Render 공유 IP의 Discord rate limit을 우회합니다.
 * 이 Worker는 Cloudflare 엣지(수백 개의 분산 IP)에서 실행됩니다.
 *
 * 배포 방법:
 *   1. https://workers.cloudflare.com 에 로그인 (무료 계정)
 *   2. "Create a Worker" 클릭
 *   3. 이 파일 전체를 붙여넣기
 *   4. 우측 상단 "Save and Deploy" 클릭
 *   5. Worker URL (예: https://discord-oauth-proxy.YOUR-NAME.workers.dev) 복사
 *   6. Render 환경변수에 OAUTH_PROXY_URL=<Worker URL> 추가
 */

const ALLOWED_ORIGIN = '*'; // 필요시 'https://discord-verify-bot-momx.onrender.com' 로 제한

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Secret',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 선택적 보안: X-Proxy-Secret 헤더 검증
    // Render 환경변수에 PROXY_SECRET 설정 시 활성화
    if (env.PROXY_SECRET) {
      const secret = request.headers.get('X-Proxy-Secret');
      if (secret !== env.PROXY_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    try {
      const body = await request.text();

      // Cloudflare 엣지 IP에서 Discord API 호출 (rate limit 우회)
      const discordRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
      });

      const data = await discordRes.text();

      return new Response(data, {
        status: discordRes.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'proxy_error', message: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
