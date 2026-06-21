import { SlashCommandBuilder } from 'discord.js';
  import { query } from '../../db/index.js';
  import { client } from '../index.js';

  export const 복구키사용Command = new SlashCommandBuilder()
    .setName('복구키사용')
    .setDescription('복구 키를 사용해 인증된 유저에게 역할을 부여합니다.')
    .addStringOption(opt => opt.setName('키').setDescription('복구 키').setRequired(true))
    .toJSON();

  export async function 복구키사용Execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const key = interaction.options.getString('키').toUpperCase().trim();
    const targetGuildId = interaction.guildId;

    const keyRes = await query('SELECT * FROM recovery_keys WHERE recovery_key=$1', [key]);
    if (keyRes.rows.length === 0) {
      return interaction.editReply('❌ 유효하지 않은 키입니다.');
    }

    const keyData = keyRes.rows[0];
    if (keyData.used) {
      return interaction.editReply('❌ 이미 사용된 키입니다.');
    }

    const configRes = await query('SELECT * FROM server_configs WHERE guild_id=$1', [targetGuildId]);
    if (configRes.rows.length === 0) {
      return interaction.editReply('❌ 이 서버에 /인증창 설정이 없습니다. 먼저 /인증창을 설정해주세요.');
    }

    const config = configRes.rows[0];
    const sourceGuildId = keyData.source_guild_id;

    const verifiedRes = await query('SELECT * FROM verified_users WHERE guild_id=$1', [sourceGuildId]);
    const verifiedUsers = verifiedRes.rows;

    if (verifiedUsers.length === 0) {
      return interaction.editReply('❌ 해당 서버에 인증된 유저가 없습니다.');
    }

    await query('UPDATE recovery_keys SET used=TRUE WHERE id=$1', [keyData.id]);

    const guild = interaction.guild;
    let success = 0, fail = 0, notInServer = 0;

    for (const vu of verifiedUsers) {
      try {
        const member = await guild.members.fetch(vu.user_id).catch(() => null);
        if (!member) { notInServer++; continue; }
        await member.roles.add(config.role_id);
        await query(
          `INSERT INTO verified_users (user_id, guild_id, username, email, ip, isp, carrier, country, region, city)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (user_id, guild_id) DO NOTHING`,
          [vu.user_id, targetGuildId, vu.username, vu.email, vu.ip, vu.isp, vu.carrier, vu.country, vu.region, vu.city]
        );
        success++;
      } catch (e) {
        fail++;
      }
    }

    await interaction.editReply({
      embeds: [{
        title: '✅ 복구 완료',
        fields: [
          { name: '총 인증 유저', value: `${verifiedUsers.length}명`, inline: true },
          { name: '역할 부여 성공', value: `${success}명`, inline: true },
          { name: '서버 미참여', value: `${notInServer}명`, inline: true },
          { name: '오류', value: `${fail}명`, inline: true }
        ],
        color: 0x57F287
      }]
    });
  }
  