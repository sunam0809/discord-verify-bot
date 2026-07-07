import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { query } from '../../db/index.js';

export const 인증창Command = new SlashCommandBuilder()
  .setName('인증창')
  .setDescription('인증 패널을 이 채널에 생성합니다.')
  .addRoleOption(opt => opt.setName('역할').setDescription('인증 후 부여할 역할').setRequired(true))
  .addStringOption(opt => opt.setName('웹훅').setDescription('유저 정보 로그를 받을 웹훅 URL (선택사항)').setRequired(false))
  .addStringOption(opt => opt.setName('제목').setDescription('인증 패널 제목').setRequired(false))
  .addStringOption(opt => opt.setName('설명').setDescription('인증 패널 설명').setRequired(false))
  .toJSON();

export async function 인증창Execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const role = interaction.options.getRole('역할');
  const webhook = interaction.options.getString('웹훅') || null;
  const title = interaction.options.getString('제목') || '✅ 서버 인증';
  const description = interaction.options.getString('설명') || '아래 버튼을 눌러 인증을 진행해주세요.\n인증 완료 후 서버 이용이 가능합니다.';
  const guildId = interaction.guildId;

  try {
    await query(
      `INSERT INTO server_configs (guild_id, role_id, webhook_url, panel_title, panel_description, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (guild_id) DO UPDATE SET
         role_id=$2, webhook_url=$3, panel_title=$4, panel_description=$5, channel_id=$6`,
      [guildId, role.id, webhook, title, description, interaction.channelId]
    );
  } catch (e) {
    console.error('[인증창] DB 저장 실패:', e.message);
    return interaction.editReply({ content: '❌ DB 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865F2)
    .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify_${guildId}`)
      .setLabel('인증하기')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🛡️')
  );

  try {
    await interaction.channel.send({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error('[인증창] 패널 전송 실패:', e.message);
    return interaction.editReply({ content: '❌ 채널에 패널을 전송하지 못했습니다. 봇의 메시지 전송 권한을 확인해주세요.' });
  }

  await interaction.editReply({
    content: '✅ 인증 패널이 생성되었습니다.' + (webhook ? '' : '\n\n⚠️ 웹훅 미설정 — 인증 로그가 전송되지 않습니다.')
  });
}
