import express from 'express';
  import session from 'express-session';
  import cookieParser from 'cookie-parser';
  import axios from 'axios';
  import path from 'path';
  import { fileURLToPath } from 'url';
  import { query } from '../db/index.js';
  import { client } from '../bot/index.js';

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const app = express();

  app.set('trust proxy', true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser(process.env.SESSION_SECRET || 'verify_secret_key'));
  app.use(session({
    secret: process.env.SESSION_SECRET || 'verify_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 10 * 60 * 1000 }
  }));
  app.use(express.static(path.join(__dirname, 'public')));

  const CLIENT_ID = process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.CLIENT_SECRET;
  const BASE_URL = process.env.BASE_URL;
  const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

  // 실제 클라이언트 IP 추출 (Render 프록시 대응)
  function getRealIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const ips = xff.split(',').map(s => s.trim());
      // 맨 왼쪽이 실제 클라이언트 IP (공인 IP만 사용)
      for (const ip of ips) {
        if (!isPrivateIp(ip)) return ip;
      }
    }
    return req.headers['x-real-ip'] || req.socket?.remoteAddress || '알 수 없음';
  }

  function isPrivateIp(ip) {
    if (!ip) return true;
    return (
      ip === '127.0.0.1' || ip === '::1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
      ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
      ip.startsWith('172.2') || ip.startsWith('172.30.') ||
      ip.startsWith('172.31.')
    );
  }

  // User-Agent로 기기 판별 (IP보다 훨씬 정확)
  function detectDevice(ua) {
    if (!ua) return { type: '알 수 없음', os: '알 수 없음', browser: '알 수 없음' };
    const uaLow = ua.toLowerCase();
    let type = '🖥️ 데스크탑';
    if (/iphone|android.*mobile|mobile.*android|blackberry|windows phone/i.test(ua)) type = '📱 스마트폰';
    else if (/ipad|android(?!.*mobile)|tablet/i.test(ua)) type = '📱 태블릿';

    let os = '알 수 없음';
    if (/windows nt 10/i.test(ua)) os = 'Windows 10/11';
    else if (/windows nt 6.3/i.test(ua)) os = 'Windows 8.1';
    else if (/windows/i.test(ua)) os = 'Windows';
    else if (/iphone os ([\d_]+)/i.test(ua)) os = 'iOS ' + ua.match(/iphone os ([\d_]+)/i)?.[1]?.replace(/_/g,'.');
    else if (/ipad; cpu os ([\d_]+)/i.test(ua)) os = 'iPadOS ' + ua.match(/cpu os ([\d_]+)/i)?.[1]?.replace(/_/g,'.');
    else if (/android ([\d.]+)/i.test(ua)) os = 'Android ' + ua.match(/android ([\d.]+)/i)?.[1];
    else if (/mac os x/i.test(ua)) os = 'macOS';
    else if (/linux/i.test(ua)) os = 'Linux';

    let browser = '알 수 없음';
    if (/edg\//i.test(ua)) browser = 'Edge';
    else if (/opr\//i.test(ua)) browser = 'Opera';
    else if (/chrome\/([\d.]+)/i.test(ua)) browser = 'Chrome ' + ua.match(/chrome\/([\d.]+)/i)?.[1]?.split('.')[0];
    else if (/firefox\/([\d.]+)/i.test(ua)) browser = 'Firefox ' + ua.match(/firefox\/([\d.]+)/i)?.[1]?.split('.')[0];
    else if (/safari\/([\d.]+)/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';

    return { type, os, browser };
  }

  // IP 지역 정보 (ip-api.com)
  async function getIpInfo(ip) {
    const def = { isp: '알 수 없음', org: '알 수 없음', country: '알 수 없음', region: '알 수 없음', city: '알 수 없음' };
    if (!ip || isPrivateIp(ip)) return def;
    try {
      const res = await axios.get(
        `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org&lang=ko`,
        { timeout: 4000 }
      );
      if (res.data.status === 'success') {
        return {
          isp: res.data.isp || '알 수 없음',
          org: res.data.org || '알 수 없음',
          country: res.data.country || '알 수 없음',
          region: res.data.regionName || '알 수 없음',
          city: res.data.city || '알 수 없음'
        };
      }
    } catch(e) { /* 실패 시 기본값 사용 */ }
    return def;
  }

  // 루트 랜딩 페이지
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Step 1: 인증창 버튼 클릭 → Discord OAuth 리다이렉트
  app.get('/verify', async (req, res) => {
    const { guild_id } = req.query;
    if (!guild_id) return res.status(400).send('Missing guild_id');

    const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [guild_id]);
    if (configRes.rows.length === 0) {
      return res.status(404).sendFile(path.join(__dirname, 'public', 'error.html'));
    }

    req.session.guild_id = guild_id;

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email',
      state: guild_id
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  // Step 2: Discord OAuth 콜백
  app.get('/oauth/callback', async (req, res) => {
    const { code, state: guild_id } = req.query;
    if (!code) return res.redirect('/verify/error?msg=' + encodeURIComponent('인증 코드가 없습니다.'));

    try {
      // 토큰 교환
      const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token } = tokenRes.data;

      // 디스코드 유저 정보 (이메일은 여기서만 정확)
      const userRes = await axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const discordUser = userRes.data;

      // 실제 IP (Render 프록시 대응)
      const realIp = getRealIp(req);

      // User-Agent 기기 정보 (IP보다 정확)
      const ua = req.headers['user-agent'] || '';
      const device = detectDevice(ua);

      // IP 기반 지역/ISP (비동기)
      const ipInfo = await getIpInfo(realIp);

      const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [guild_id]);
      const config = configRes.rows[0];

      // 세션에 저장
      req.session.pendingVerify = {
        userId: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name || discordUser.username,
        avatar: discordUser.avatar,
        email: discordUser.email || '비공개',
        ip: realIp,
        isp: ipInfo.isp,
        org: ipInfo.org,
        country: ipInfo.country,
        region: ipInfo.region,
        city: ipInfo.city,
        deviceType: device.type,
        os: device.os,
        browser: device.browser,
        guild_id,
        panelTitle: config?.panel_title || '서버 인증'
      };

      res.redirect('/verify/confirm');
    } catch (err) {
      console.error('[OAuth] Error:', err.response?.data || err.message);
      res.redirect('/verify/error?msg=' + encodeURIComponent('인증 처리 중 오류가 발생했습니다.'));
    }
  });

  // Step 3: 인증 확인 페이지 (IP/위치 숨김, 유저 정보만 표시)
  app.get('/verify/confirm', (req, res) => {
    if (!req.session.pendingVerify) {
      return res.redirect('/verify/error?msg=' + encodeURIComponent('세션이 만료되었습니다. 다시 시도해주세요.'));
    }
    res.sendFile(path.join(__dirname, 'public', 'confirm.html'));
  });

  // API: 페이지용 데이터 (민감 정보 제외)
  app.get('/api/verify-data', (req, res) => {
    if (!req.session.pendingVerify) return res.status(401).json({ error: 'No session' });
    const d = req.session.pendingVerify;
    // 페이지에는 기본 정보만 전달 (IP/위치 제외)
    res.json({
      userId: d.userId,
      username: d.username,
      globalName: d.globalName,
      avatar: d.avatar,
      panelTitle: d.panelTitle
    });
  });

  // Step 4: 인증 완료
  app.post('/api/verify-complete', async (req, res) => {
    if (!req.session.pendingVerify) {
      return res.status(401).json({ success: false, error: '세션이 만료되었습니다.' });
    }
    const d = req.session.pendingVerify;

    try {
      const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [d.guild_id]);
      if (configRes.rows.length === 0) {
        return res.json({ success: false, error: '서버 설정을 찾을 수 없습니다.' });
      }
      const config = configRes.rows[0];

      // 역할 부여
      try {
        const guild = client.guilds.cache.get(d.guild_id);
        if (guild) {
          const member = await guild.members.fetch(d.userId).catch(() => null);
          if (member) await member.roles.add(config.role_id);
        }
      } catch(e) {
        console.error('[Verify] Role error:', e.message);
      }

      // DB 저장
      await query(
        `INSERT INTO verified_users (user_id, guild_id, username, email, ip, isp, carrier, country, region, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id, guild_id) DO UPDATE SET
           username=$3, email=$4, ip=$5, isp=$6, carrier=$7, country=$8, region=$9, city=$10`,
        [d.userId, d.guild_id, d.username, d.email, d.ip, d.isp, d.org, d.country, d.region, d.city]
      );

      // 웹훅 로그 (상세 정보 전부 포함)
      const avatarUrl = d.avatar
        ? `https://cdn.discordapp.com/avatars/${d.userId}/${d.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

      try {
        await axios.post(config.webhook_url, {
          embeds: [{
            title: '🛡️ 인증 로그',
            color: 0x57F287,
            thumbnail: { url: avatarUrl },
            fields: [
              { name: '👤 유저', value: `<@${d.userId}> (${d.globalName})`, inline: true },
              { name: '🆔 유저 ID', value: `\`${d.userId}\``, inline: true },
              { name: '📧 이메일', value: d.email, inline: false },
              { name: '🌐 접속 IP', value: `\`${d.ip}\``, inline: true },
              { name: '🏢 ISP', value: d.isp, inline: true },
              { name: '📍 예상 위치', value: `${d.country} / ${d.region} / ${d.city}`, inline: false },
              { name: '💻 기기 유형', value: d.deviceType, inline: true },
              { name: '🖥️ 운영체제', value: d.os, inline: true },
              { name: '🌏 브라우저', value: d.browser, inline: true }
            ],
            footer: { text: `인증 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` }
          }]
        });
      } catch(e) {
        console.error('[Verify] Webhook error:', e.message);
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
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  export default app;
  