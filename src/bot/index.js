import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
  import { 인증창Command, 인증창Execute } from './commands/인증창.js';
  import { 복구키생성Command, 복구키생성Execute } from './commands/복구키생성.js';
  import { 복구키사용Command, 복구키사용Execute } from './commands/복구키사용.js';
  import { handleButtonInteraction } from './interactions.js';

  const ALLOWED_ROLE_ID = '1368030640628301865';
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CLIENT_ID = process.env.CLIENT_ID;

  export const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages
    ]
  });

  const commands = [인증창Command, 복구키생성Command, 복구키사용Command];

  export async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('[Bot] Slash commands registered globally');
  }

  // Discord.js 슬래시 커맨드 인터랙션에서 member.roles 는
  // 캐시된 GuildMember면 Collection, 아니면 role ID 문자열 배열로 옴
  function hasAllowedRole(member) {
    if (!member) return false;
    const roles = member.roles;
    // API interaction member: roles is a string[]
    if (Array.isArray(roles)) {
      return roles.includes(ALLOWED_ROLE_ID);
    }
    // Cached GuildMember: roles is GuildMemberRoleManager
    if (roles && typeof roles.cache !== 'undefined') {
      return roles.cache.has(ALLOWED_ROLE_ID);
    }
    return false;
  }

  client.once('ready', () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (!hasAllowedRole(interaction.member)) {
      return interaction.reply({ content: '❌ 이 명령어를 사용할 권한이 없습니다.', ephemeral: true });
    }

    try {
      if (interaction.commandName === '인증창') await 인증창Execute(interaction);
      else if (interaction.commandName === '복구키생성') await 복구키생성Execute(interaction);
      else if (interaction.commandName === '복구키사용') await 복구키사용Execute(interaction);
    } catch (err) {
      console.error('[Bot] Command error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ 오류가 발생했습니다.', ephemeral: true });
      }
    }
  });

  export async function startBot() {
    await client.login(BOT_TOKEN);
  }
  