import { SlashCommandBuilder } from 'discord.js';
import { query } from '../../db/index.js';
import axios from 'axios';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;

export const 복구키사용Command = new SlashCommandBuilder()
  .setName('복구키사용')
  .setDescription('복구 키로 인증된 유저를 이 서버로 강제 초대합니다.')
  .addStringOption(opt => opt.setName('키').setDescription('복구 키').setRequired(true))
  .toJSON();

async function refreshAccessToken(refreshToken) {
  try {
    const res = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return { access_token: res.data.access_token, refresh_token: res.data.refresh_token, expires_in: res.data.expires_in };
  } catch(e) {
    return null;
  }
}

async function addMemberToGuild(guildId, userId, accessToken, roleId) {
  try {
    const res = await axios.put(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { access_token: accessToken, roles: roleId ? [roleId] : [] },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return { ok: true, alreadyIn: res.status === 204 };
  } catch(e) {
    return { ok: false, status: e.response?.status, error: e.response?.data };
  }
}

export async function 복구키사용Execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const key = interaction.options.getString('키').toUpperCase().trim();
  const targetGuildId = interaction.guildId;

  const keyRes = await query('SELECT * FROM recovery_keys WHERE recovery_key=$1', [key]);
  if (keyRes.rows.length === 0) return interaction.editReply('❌ 유효하지 않은 키입니다.');
  const keyData = keyRes.rows[0];
  if (keyData.used) return interaction.editReply('❌ 이미 사용된 키입니다.');

  const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [targetGuildId]);
  if (configRes.rows.length === 0) return interaction.editReply('❌ 이 서버에 /인증창 설정이 없습니다. 먼저 /인증창을 실행해주세요.');
  const config = configRes.rows[0];

  const usersRes = await query(
    'SELECT * FROM verified_users WHERE guild_id=$1 AND access_token IS NOT NULL',
    [keyData.source_guild_id]
  );
  const users = usersRes.rows;

  if (users.length === 0) return interaction.editReply('❌ 해당 서버에 초대 가능한 인증 유저가 없습니다.\n(guilds.join 권한으로 인증한 유저만 초대 가능합니다)');

  await query('UPDATE recovery_keys SET used=TRUE WHERE id=$1', [keyData.id]);
  await interaction.editReply(`⏳ ${users.length}명 초대 중... 잠시 기다려주세요.`);

  let invited = 0, alreadyIn = 0, failed = 0, tokenFailed = 0;

  for (const user of users) {
    let token = user.access_token;
    let refreshToken = user.refresh_token;
    let refreshed = null;

    // token_expires_at 유무와 관계없이 항상 갱신 시도
    // (token_expires_at이 NULL인 경우에도 토큰이 만료되어 있을 수 있음)
    if (refreshToken) {
      refreshed = await refreshAccessToken(refreshToken);
      if (refreshed) {
        token = refreshed.access_token;
        refreshToken = refreshed.refresh_token;
        const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
        await query(
          'UPDATE verified_users SET access_token=$1, refresh_token=$2, token_expires_at=$3 WHERE id=$4',
          [token, refreshToken, newExpiry.toISOString(), user.id]
        ).catch(() => {});
      }
      // 갱신 실패해도 기존 토큰으로 계속 시도 (continue 제거)
    }

    const result = await addMemberToGuild(targetGuildId, user.user_id, token, config.role_id);

    if (result.ok) {
      if (result.alreadyIn) {
        try {
          await axios.put(
            `https://discord.com/api/v10/guilds/${targetGuildId}/members/${user.user_id}/roles/${config.role_id}`,
            {},
            { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
          );
        } catch(e) {}
        alreadyIn++;
      } else {
        invited++;
      }

      await query(
        `INSERT INTO verified_users (user_id, guild_id, username, email, ip, isp, carrier, country, region, city, access_token, refresh_token, token_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (user_id, guild_id) DO NOTHING`,
        [user.user_id, targetGuildId, user.username, user.email, user.ip,
         user.isp, user.carrier, user.country, user.region, user.city,
         token, refreshToken, user.token_expires_at]
      );
    } else {
      // 갱신도 실패하고 초대도 실패한 경우만 tokenFailed
      if (!refreshed && refreshToken) {
        tokenFailed++;
      } else {
        failed++;
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  await interaction.editReply({ embeds: [{
    title: '✅ 복구 완료',
    color: 0x57F287,
    fields: [
      { name: '📋 총 대상', value: `${users.length}명`, inline: true },
      { name: '✅ 새로 초대됨', value: `${invited}명`, inline: true },
      { name: '🔄 이미 있음 (역할 부여)', value: `${alreadyIn}명`, inline: true },
      { name: '🔑 토큰 만료 (재인증 필요)', value: `${tokenFailed}명`, inline: true },
      { name: '❌ 초대 실패', value: `${failed}명`, inline: true }
    ],
    footer: { text: '토큰 만료는 유저가 재인증해야 합니다.' }
  }]});
}
