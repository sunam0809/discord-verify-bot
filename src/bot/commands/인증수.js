import { SlashCommandBuilder } from 'discord.js';
import { query } from '../../db/index.js';

export const 인증수Command = new SlashCommandBuilder()
  .setName('인증수')
  .setDescription('이 서버의 인증된 유저 수를 확인합니다.')
  .toJSON();

export async function 인증수Execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId;

  try {
    const [totalRes, todayRes, weekRes] = await Promise.all([
      query('SELECT COUNT(*) FROM verified_users WHERE guild_id=$1', [guildId]),
      query(`SELECT COUNT(*) FROM verified_users WHERE guild_id=$1 AND verified_at >= NOW() - INTERVAL '24 hours'`, [guildId]),
      query(`SELECT COUNT(*) FROM verified_users WHERE guild_id=$1 AND verified_at >= NOW() - INTERVAL '7 days'`, [guildId])
    ]);

    const total = parseInt(totalRes.rows[0].count);
    const today = parseInt(todayRes.rows[0].count);
    const week = parseInt(weekRes.rows[0].count);

    await interaction.editReply({
      embeds: [{
        title: '📊 인증 현황',
        color: 0x5865F2,
        fields: [
          { name: '✅ 전체 인증 수', value: `**${total.toLocaleString()}명**`, inline: true },
          { name: '📅 오늘 인증', value: `**${today.toLocaleString()}명**`, inline: true },
          { name: '📆 이번 주 인증', value: `**${week.toLocaleString()}명**`, inline: true }
        ],
        footer: { text: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined },
        timestamp: new Date().toISOString()
      }]
    });
  } catch (e) {
    console.error('[인증수] 오류:', e.message);
    await interaction.editReply({ content: '❌ 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
}
