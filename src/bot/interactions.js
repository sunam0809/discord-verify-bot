import { query } from '../db/index.js';

  export async function handleButtonInteraction(interaction) {
    if (!interaction.customId.startsWith('verify_')) return;

    const guildId = interaction.customId.replace('verify_', '');
    const userId = interaction.user.id;
    const BASE_URL = process.env.BASE_URL;

    const verifyUrl = `${BASE_URL}/verify?guild_id=${guildId}&user_id=${userId}&username=${encodeURIComponent(interaction.user.username)}`;

    await interaction.reply({
      content: `✅ 아래 버튼을 클릭하여 인증을 완료하세요!`,
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: '🔗 인증 사이트로 이동',
          url: verifyUrl
        }]
      }],
      ephemeral: true
    });
  }
  