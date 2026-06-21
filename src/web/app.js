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

  // Root landing page
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Step 1: User clicks verify button -> redirect to Discord OAuth
  app.get('/verify', async (req, res) => {
    const { guild_id, user_id, username } = req.query;
    if (!guild_id) return res.status(400).send('Missing guild_id');

    const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [guild_id]);
    if (configRes.rows.length === 0) {
      return res.status(404).send('서버 설정을 찾을 수 없습니다. 서버 관리자에게 문의하세요.');
    }

    req.session.guild_id = guild_id;
    req.session.expected_user_id = user_id;

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email',
      state: guild_id
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  // Step 2: Discord OAuth callback
  app.get('/oauth/callback', async (req, res) => {
    const { code, state: guild_id } = req.query;
    if (!code) return res.status(400).send('No code provided');

    try {
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

      const userRes = await axios.get('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const discordUser = userRes.data;

      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      let ipInfo = { isp: '알 수 없음', carrier: '알 수 없음', country: '알 수 없음', region: '알 수 없음', city: '알 수 없음', mobile: false };
      try {
        const ipRes = await axios.get(`http://ip-api.com/json/${clientIp}?fields=country,regionName,city,isp,org,mobile`, { timeout: 3000 });
        if (ipRes.data.country) {
          ipInfo = {
            isp: ipRes.data.isp || '알 수 없음',
            carrier: ipRes.data.org || '알 수 없음',
            country: ipRes.data.country || '알 수 없음',
            region: ipRes.data.regionName || '알 수 없음',
            city: ipRes.data.city || '알 수 없음',
            mobile: ipRes.data.mobile || false
          };
        }
      } catch(e) {}

      const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [guild_id]);
      const config = configRes.rows[0];

      req.session.pendingVerify = {
        userId: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
        email: discordUser.email || '비공개',
        ip: clientIp,
        isp: ipInfo.isp,
        carrier: ipInfo.carrier,
        country: ipInfo.country,
        region: ipInfo.region,
        city: ipInfo.city,
        mobile: ipInfo.mobile,
        guild_id,
        guild_name: config?.panel_title || '서버'
      };

      res.redirect('/verify/confirm');
    } catch (err) {
      console.error('[OAuth] Error:', err.response?.data || err.message);
      res.redirect('/verify/error?msg=' + encodeURIComponent('인증 처리 중 오류가 발생했습니다.'));
    }
  });

  // Step 3: Show confirm page
  app.get('/verify/confirm', (req, res) => {
    if (!req.session.pendingVerify) {
      return res.redirect('/verify/error?msg=' + encodeURIComponent('세션이 만료되었습니다. 다시 시도해주세요.'));
    }
    res.sendFile(path.join(__dirname, 'public', 'confirm.html'));
  });

  // API: get pending verify data
  app.get('/api/verify-data', (req, res) => {
    if (!req.session.pendingVerify) return res.status(401).json({ error: 'No session' });
    res.json(req.session.pendingVerify);
  });

  // Step 4: Complete verification
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

      try {
        const guild = client.guilds.cache.get(d.guild_id);
        if (guild) {
          const member = await guild.members.fetch(d.userId).catch(() => null);
          if (member) await member.roles.add(config.role_id);
        }
      } catch(e) {
        console.error('[Verify] Role assign error:', e.message);
      }

      await query(
        `INSERT INTO verified_users (user_id, guild_id, username, email, ip, isp, carrier, country, region, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id, guild_id) DO UPDATE SET
           username=$3, email=$4, ip=$5, isp=$6, carrier=$7, country=$8, region=$9, city=$10`,
        [d.userId, d.guild_id, d.username, d.email, d.ip, d.isp, d.carrier, d.country, d.region, d.city]
      );

      const isMobile = d.mobile ? '📱 모바일' : '🖥️ 데스크탑';
      const avatarUrl = d.avatar
        ? `https://cdn.discordapp.com/avatars/${d.userId}/${d.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

      try {
        await axios.post(config.webhook_url, {
          embeds: [{
            title: '✅ 인증 로그',
            color: 0x57F287,
            thumbnail: { url: avatarUrl },
            fields: [
              { name: '유저', value: `<@${d.userId}> (${d.username})`, inline: true },
              { name: '유저 ID', value: d.userId, inline: true },
              { name: '이메일', value: d.email, inline: false },
              { name: '접속 IP', value: `\`${d.ip}\``, inline: true },
              { name: 'ISP / 통신사', value: d.isp, inline: true },
              { name: '기기 유형', value: isMobile, inline: true },
              { name: '예상 통신사', value: d.carrier, inline: true },
              { name: '예상 지역', value: `${d.country} / ${d.region} / ${d.city}`, inline: false }
            ],
            footer: { text: `인증 시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` }
          }]
        });
      } catch(e) {
        console.error('[Verify] Webhook error:', e.message);
      }

      req.session.pendingVerify = null;
      req.session.verified = true;
      res.json({ success: true });
    } catch(err) {
      console.error('[Verify] Complete error:', err);
      res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
    }
  });

  app.get('/verify/done', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'done.html'));
  });

  app.get('/verify/error', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'error.html'));
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  export default app;
  