import { SlashCommandBuilder } from 'discord.js';
  import { query } from '../../db/index.js';
  import { randomBytes } from 'crypto';

  export const 복구키생성Command = new SlashCommandBuilder()
    .setName('복구키생성')
    .setDescription('이 서버 인증 데이터를 복구할 1회용 키를 생성합니다.')
    .toJSON();

  export async function 복구키생성Execute(interaction) {
    const guildId = interaction.guildId;

    const configRes = await query('SELECT guild_id FROM server_configs WHERE guild_id=$1', [guildId]);
    if (configRes.rows.length === 0) {
      return interaction.reply({ content: '❌ 먼저 /인증창 명령어로 인증 패널을 설정해주세요.', ephemeral: true });
    }

    const key = randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-');

    await query(
      'INSERT INTO recovery_keys (recovery_key, source_guild_id) VALUES ($1, $2)',
      [key, guildId]
    );

    await interaction.reply({
      embeds: [{
        title: '🔑 복구 키 생성 완료',
        description: `아래 키를 안전한 곳에 보관하세요.\n이 키는 **1회만** 사용 가능합니다.\n\n\`\`\`\n${key}\n\`\`\``,
        color: 0x5865F2,
        footer: { text: '이 키로 인증된 유저를 다른 서버로 복구할 수 있습니다.' }
      }],
      ephemeral: true
    });
  }
  