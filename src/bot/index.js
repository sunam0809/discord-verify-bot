import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { 인증창Command, 인증창Execute } from './commands/인증창.js';
import { 복구키생성Command, 복구키생성Execute } from './commands/복구키생성.js';
import { 복구키사용Command, 복구키사용Execute } from './commands/복구키사용.js';
import { 인증수Command, 인증수Execute } from './commands/인증수.js';
import { handleButtonInteraction } from './interactions.js';

const ALLOWED_USER_ID = '1368030640628301865';
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Guilds 인텐트만 사용 (슬래시 명령어에 필요한 것만)
export const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [인증창Command, 복구키생성Command, 복구키사용Command, 인증수Command];

export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('[Bot] Slash commands registered globally');
}

client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== ALLOWED_USER_ID) {
      return interaction.reply({ content: '❌ 이 명령어를 사용할 권한이 없습니다.', ephemeral: true });
    }

    if (interaction.commandName === '인증창') await 인증창Execute(interaction);
    else if (interaction.commandName === '복구키생성') await 복구키생성Execute(interaction);
    else if (interaction.commandName === '복구키사용') await 복구키사용Execute(interaction);
    else if (interaction.commandName === '인증수') await 인증수Execute(interaction);

  } catch (err) {
    console.error('[Bot] Interaction error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: '❌ 처리 중 오류가 발생했습니다.' });
      } else if (!interaction.replied) {
        await interaction.reply({ content: '❌ 오류가 발생했습니다.', ephemeral: true });
      }
    } catch (_) {}
  }
});

export async function startBot() {
  await client.login(BOT_TOKEN);
}
