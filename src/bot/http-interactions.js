import axios from 'axios';
import { query } from '../db/index.js';
import { randomBytes } from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL;

async function withRetry(fn, maxAttempts = 4) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch(e) {
      if (e.response?.status === 429 && i < maxAttempts - 1) {
        const retryAfter = parseFloat(e.response.headers?.['retry-after'] || '2');
        const wait = Math.min(retryAfter * 1000 + 500, 12000);
        console.warn(`[Retry] 429 rate limit, waiting ${wait}ms (attempt ${i + 1}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

async function editReply(token, content) {
  const payload = typeof content === 'string' ? { content } : content;
  try {
    await withRetry(() => axios.patch(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`,
      payload,
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    ));
    console.log('[editReply] OK');
  } catch(e) {
    console.error('[editReply] FAILED:', e.response?.status, JSON.stringify(e.response?.data), e.message);
  }
}

function getOption(interaction, name) {
  return interaction.data.options?.find(o => o.name === name)?.value;
}

async function sendToChannel(channelId, payload) {
  const res = await withRetry(() => axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    payload,
    { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
  ));
  return res.data;
}

async function addRole(guildId, userId, roleId) {
  await withRetry(() => axios.put(
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {},
    { headers: { Authorization: `Bot ${BOT_TOKEN}` }, timeout: 8000 }
  )).catch(e => console.error('[addRole]', e.response?.status, e.message));
}

async function addMemberToGuild(guildId, userId, accessToken, roleId) {
  try {
    const res = await withRetry(() => axios.put(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { access_token: accessToken, roles: roleId ? [roleId] : [] },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 8000 }
    ));
    return { ok: true, alreadyIn: res.status === 204 };
  } catch(e) {
    return { ok: false, status: e.response?.status };
  }
}

async function refreshAccessToken(refreshToken) {
  try {
    const res = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: APP_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );
    return { access_token: res.data.access_token, refresh_token: res.data.refresh_token, expires_in: res.data.expires_in };
  } catch(e) { return null; }
}

async function getGuild(guildId) {
  const res = await withRetry(() => axios.get(
    `https://discord.com/api/v10/guilds/${guildId}`,
    { headers: { Authorization: `Bot ${BOT_TOKEN}` }, timeout: 8000 }
  ));
  return res.data;
}

function guildIcon(guildId, icon) {
  return icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png` : undefined;
}

const ALLOWED_USER_ID = '1368030640628301865';

export async function handleHttpInteraction(interaction, res) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const guildId = interaction.guild_id;
  const token = interaction.token;

  console.log('[Interaction] type:', interaction.type, 'name:', interaction.data?.name, 'userId:', userId, 'guildId:', guildId);

  // ── 버튼 ──
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id || '';
    if (customId.startsWith('verify_')) {
      const btnGuildId = customId.replace('verify_', '');
      const username = interaction.member?.user?.username || '';
      const verifyUrl = `${BASE_URL}/verify?guild_id=${btnGuildId}&user_id=${userId}&username=${encodeURIComponent(username)}`;
      return res.json({
        type: 4,
        data: {
          content: '✅ 아래 버튼을 클릭하여 인증을 완료하세요!',
          components: [{ type: 1, components: [{ type: 2, style: 5, label: '🔗 인증 사이트로 이동', url: verifyUrl }] }],
          flags: 64
        }
      });
    }
    return res.json({ type: 1 });
  }

  // ── 슬래시 명령어 ──
  if (interaction.type === 2) {
    if (userId !== ALLOWED_USER_ID) {
      return res.json({ type: 4, data: { content: '❌ 이 명령어를 사용할 권한이 없습니다.', flags: 64 } });
    }

    const name = interaction.data.name;
    console.log('[Command]', name, 'token prefix:', token?.slice(0, 20));

    // ─── 인증수 (즉시 응답) ───
    if (name === '인증수') {
      try {
        const [totalR, todayR, weekR, guild] = await Promise.all([
          query('SELECT COUNT(*) FROM verified_users WHERE guild_id=$1', [guildId]),
          query(`SELECT COUNT(*) FROM verified_users WHERE guild_id=$1 AND verified_at >= NOW() - INTERVAL '24 hours'`, [guildId]),
          query(`SELECT COUNT(*) FROM verified_users WHERE guild_id=$1 AND verified_at >= NOW() - INTERVAL '7 days'`, [guildId]),
          getGuild(guildId)
        ]);
        const total = parseInt(totalR.rows[0].count);
        const today = parseInt(todayR.rows[0].count);
        const week = parseInt(weekR.rows[0].count);
        return res.json({
          type: 4,
          data: {
            embeds: [{
              title: '📊 인증 현황', color: 0x5865F2,
              fields: [
                { name: '✅ 전체 인증 수', value: `**${total.toLocaleString()}명**`, inline: true },
                { name: '📅 오늘 인증', value: `**${today.toLocaleString()}명**`, inline: true },
                { name: '📆 이번 주 인증', value: `**${week.toLocaleString()}명**`, inline: true }
              ],
              footer: { text: guild.name, icon_url: guildIcon(guildId, guild.icon) },
              timestamp: new Date().toISOString()
            }],
            flags: 64
          }
        });
      } catch(err) {
        console.error('[인증수] Error:', err.message);
        return res.json({ type: 4, data: { content: `❌ 오류: ${err.message}`, flags: 64 } });
      }
    }

    // ─── 복구키생성 (즉시 응답) ───
    if (name === '복구키생성') {
      try {
        const cfg = await query('SELECT guild_id FROM server_configs WHERE guild_id=$1', [guildId]);
        if (cfg.rows.length === 0) {
          return res.json({ type: 4, data: { content: '❌ 먼저 /인증창 명령어로 인증 패널을 설정해주세요.', flags: 64 } });
        }
        const key = randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-');
        await query('INSERT INTO recovery_keys (recovery_key, source_guild_id) VALUES ($1,$2)', [key, guildId]);
        return res.json({
          type: 4,
          data: {
            embeds: [{
              title: '🔑 복구 키 생성 완료',
              description: `아래 키를 안전한 곳에 보관하세요.\n이 키는 **1회만** 사용 가능합니다.\n\n\`\`\`\n${key}\n\`\`\``,
              color: 0x5865F2,
              footer: { text: '이 키로 인증된 유저를 다른 서버로 복구할 수 있습니다.' }
            }],
            flags: 64
          }
        });
      } catch(err) {
        console.error('[복구키생성] Error:', err.message);
        return res.json({ type: 4, data: { content: `❌ 오류: ${err.message}`, flags: 64 } });
      }
    }

    // ─── 인증창 (즉시 응답 + 백그라운드 패널 전송) ───
    if (name === '인증창') {
      const roleId = interaction.data.options?.find(o => o.name === '역할')?.value;
      const webhook = getOption(interaction, '웹훅');
      const title = getOption(interaction, '제목') || '✅ 서버 인증';
      const description = getOption(interaction, '설명') || '아래 버튼을 눌러 인증을 진행해주세요.\n인증 완료 후 서버 이용이 가능합니다.';
      const channelId = interaction.channel_id;
      console.log('[인증창] guildId:', guildId, 'roleId:', roleId, 'channelId:', channelId);

      try {
        await query(
          `INSERT INTO server_configs (guild_id, role_id, webhook_url, panel_title, panel_description, channel_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (guild_id) DO UPDATE SET role_id=$2, webhook_url=$3, panel_title=$4, panel_description=$5, channel_id=$6`,
          [guildId, roleId, webhook, title, description, channelId]
        );
        console.log('[인증창] DB saved');
      } catch(err) {
        console.error('[인증창] DB error:', err.message);
        return res.json({ type: 4, data: { content: `❌ 설정 저장 실패: ${err.message}`, flags: 64 } });
      }

      // DB 저장 완료 → 즉시 응답 (생각중이에요 없음)
      res.json({ type: 4, data: { content: '✅ 설정이 저장되었습니다. 채널에 인증 패널을 생성 중입니다...', flags: 64 } });

      // 패널 전송은 백그라운드에서 처리
      setImmediate(async () => {
        try {
          let guild = null;
          try { guild = await getGuild(guildId); } catch(gErr) { console.warn('[인증창] getGuild skipped:', gErr.response?.status, gErr.message); }
          const panelPayload = {
            embeds: [{
              title, description, color: 0x5865F2,
              ...(guild ? { footer: { text: guild.name, icon_url: guildIcon(guildId, guild.icon) } } : {}),
              timestamp: new Date().toISOString()
            }],
            components: [{
              type: 1,
              components: [{ type: 2, style: 1, label: '인증하기', custom_id: `verify_${guildId}`, emoji: { name: '🛡️' } }]
            }]
          };
          if (webhook) {
            // 웹훅 URL 사용 — BOT_TOKEN rate limit 우회
            console.log('[인증창] sending panel via webhook');
            await withRetry(() => axios.post(webhook, panelPayload, { timeout: 8000 }));
          } else {
            console.log('[인증창] sending panel to channel:', channelId);
            await sendToChannel(channelId, panelPayload);
          }
          console.log('[인증창] Panel sent successfully');
        } catch(err) {
          console.error('[인증창] Panel send failed:', err.message, err.response?.data);
        }
      });
      return;
    }

    // ─── 복구키사용 (defer 필요) ───
    if (name === '복구키사용') {
      res.json({ type: 5, data: { flags: 64 } });
      try {
        const keyInput = getOption(interaction, '키');
        if (!keyInput) { await editReply(token, '❌ 키를 입력해주세요.'); return; }
        const key = keyInput.toUpperCase().trim();
        console.log('[복구키사용] key:', key);
        const keyRes = await query('SELECT * FROM recovery_keys WHERE recovery_key=$1', [key]);
        if (keyRes.rows.length === 0) { await editReply(token, '❌ 유효하지 않은 키입니다.'); return; }
        const keyData = keyRes.rows[0];
        if (keyData.used) { await editReply(token, '❌ 이미 사용된 키입니다.'); return; }
        const cfgRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [guildId]);
        if (cfgRes.rows.length === 0) { await editReply(token, '❌ 이 서버에 /인증창 설정이 없습니다.'); return; }
        const config = cfgRes.rows[0];
        const usersRes = await query('SELECT * FROM verified_users WHERE guild_id=$1 AND access_token IS NOT NULL', [keyData.source_guild_id]);
        const users = usersRes.rows;
        if (users.length === 0) { await editReply(token, '❌ 해당 서버에 초대 가능한 인증 유저가 없습니다.'); return; }
        await query('UPDATE recovery_keys SET used=TRUE WHERE id=$1', [keyData.id]);
        await editReply(token, `⏳ ${users.length}명 초대 중... 잠시 기다려주세요.`);

        let invited = 0, alreadyIn = 0, failed = 0, tokenFailed = 0;
        for (const user of users) {
          let tok = user.access_token;
          let ref = user.refresh_token;
          const isExpired = user.token_expires_at && new Date(user.token_expires_at) < new Date();
          if (isExpired && ref) {
            const refreshed = await refreshAccessToken(ref);
            if (refreshed) {
              tok = refreshed.access_token; ref = refreshed.refresh_token;
              await query('UPDATE verified_users SET access_token=$1, refresh_token=$2, token_expires_at=$3 WHERE id=$4',
                [tok, ref, new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), user.id]);
            } else { tokenFailed++; continue; }
          }
          const result = await addMemberToGuild(guildId, user.user_id, tok, config.role_id);
          if (result.ok) {
            if (result.alreadyIn) { await addRole(guildId, user.user_id, config.role_id); alreadyIn++; }
            else invited++;
            await query(
              `INSERT INTO verified_users (user_id, guild_id, username, email, ip, isp, carrier, country, region, city, access_token, refresh_token, token_expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (user_id, guild_id) DO NOTHING`,
              [user.user_id, guildId, user.username, user.email, user.ip, user.isp, user.carrier,
               user.country, user.region, user.city, tok, ref, user.token_expires_at]
            );
          } else failed++;
          await new Promise(r => setTimeout(r, 500));
        }
        await editReply(token, {
          embeds: [{
            title: '✅ 복구 완료', color: 0x57F287,
            fields: [
              { name: '📋 총 대상', value: `${users.length}명`, inline: true },
              { name: '✅ 새로 초대됨', value: `${invited}명`, inline: true },
              { name: '🔄 이미 있음 (역할 부여)', value: `${alreadyIn}명`, inline: true },
              { name: '🔑 토큰 만료 (갱신 실패)', value: `${tokenFailed}명`, inline: true },
              { name: '❌ 초대 실패', value: `${failed}명`, inline: true }
            ],
            footer: { text: '토큰 만료는 유저가 재인증해야 합니다.' }
          }]
        });
      } catch(err) {
        console.error('[복구키사용] Error:', err.message);
        await editReply(token, `❌ 오류가 발생했습니다: ${err.message}`);
      }
      return;
    }
  }

  res.json({ type: 1 });
}
