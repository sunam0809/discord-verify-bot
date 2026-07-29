/**
 * Cloudflare Worker — Discord 인터랙션 즉시 응답 프록시
 *
 * 역할:
 *   1. Discord 서명 검증 (즉각, 밀리초 내)
 *   2. type 1 (PING) → 즉시 응답
 *   3. type 3 (버튼) → 즉시 URL 응답 (Render 호출 없음)
 *   4. type 2 (슬래시 명령어) → 즉시 type 5 deferred 응답 후
 *      백그라운드로 Render /bg-interaction 에 전달
 *
 * 이렇게 하면 Render 무료 플랜이 슬립 상태여도
 * Discord 3초 타임아웃이 발생하지 않습니다.
 *
 * 배포 방법:
 *   1. https://workers.cloudflare.com 에서 새 Worker 생성
 *   2. 이 파일 전체 붙여넣기
 *   3. Settings > Variables 에서 다음 시크릿 추가:
 *      - PUBLIC_KEY : Discord 앱 Public Key
 *      - WORKER_SECRET : 임의의 랜덤 문자열 (Render에도 동일하게 설정)
 *      - RENDER_URL : https://discord-verify-bot-60bw.onrender.com
 *   4. Save & Deploy
 *   5. Worker URL을 Discord 개발자 포털 > Interactions Endpoint URL 에 등록
 *      예) https://discord-proxy.YOUR-NAME.workers.dev/interactions
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'POST' || url.pathname !== '/interactions') {
      return new Response('Not Found', { status: 404 });
    }

    // Discord 서명 검증
    const sig = request.headers.get('x-signature-ed25519');
    const ts  = request.headers.get('x-signature-timestamp');
    if (!sig || !ts) return new Response('Invalid signature', { status: 401 });

    const rawBody = await request.arrayBuffer();
    const bodyText = new TextDecoder().decode(rawBody);

    const isValid = await verifyDiscordSignature(env.PUBLIC_KEY, sig, ts, rawBody);
    if (!isValid) return new Response('Invalid signature', { status: 401 });

    let interaction;
    try {
      interaction = JSON.parse(bodyText);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // ── type 1: PING ──────────────────────────────────────────────
    if (interaction.type === 1) {
      return jsonResponse({ type: 1 });
    }

    // ── type 3: 버튼 클릭 ─────────────────────────────────────────
    // Render를 깨우지 않고 CF Worker에서 바로 처리
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id || '';
      if (customId.startsWith('verify_')) {
        const guildId  = customId.replace('verify_', '');
        const userId   = interaction.member?.user?.id   || interaction.user?.id   || '';
        const username = interaction.member?.user?.username || interaction.user?.username || '';
        const renderUrl = env.RENDER_URL || 'https://discord-verify-bot-60bw.onrender.com';
        const verifyUrl = `${renderUrl}/verify?guild_id=${guildId}&user_id=${userId}&username=${encodeURIComponent(username)}`;
        return jsonResponse({
          type: 4,
          data: {
            content: '아래 버튼을 눌러 인증을 완료하세요.',
            components: [{
              type: 1,
              components: [{ type: 2, style: 5, label: '🔗 인증 사이트로 이동', url: verifyUrl }]
            }],
            flags: 64
          }
        });
      }
      return jsonResponse({ type: 1 });
    }

    // ── type 2: 슬래시 명령어 ──────────────────────────────────────
    // 1) Discord에 즉시 deferred 응답 (3초 내 응답 보장)
    // 2) Render /bg-interaction 에 백그라운드 전달
    if (interaction.type === 2) {
      const renderUrl    = env.RENDER_URL || 'https://discord-verify-bot-60bw.onrender.com';
      const workerSecret = env.WORKER_SECRET || '';

      ctx.waitUntil(
        fetch(`${renderUrl}/bg-interaction`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-Secret': workerSecret,
          },
          body: bodyText,
        }).catch(err => console.error('[Worker] Render 전달 실패:', err.message))
      );

      return jsonResponse({ type: 5, data: { flags: 64 } });
    }

    return jsonResponse({ type: 1 });
  },
};

// ── 유틸 ──────────────────────────────────────────────────────────

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function verifyDiscordSignature(publicKey, signature, timestamp, bodyBuffer) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const timestampBytes = new TextEncoder().encode(timestamp);
    const bodyBytes      = new Uint8Array(bodyBuffer);
    const message        = new Uint8Array(timestampBytes.length + bodyBytes.length);
    message.set(timestampBytes, 0);
    message.set(bodyBytes, timestampBytes.length);

    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signature), message);
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
