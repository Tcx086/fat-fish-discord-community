const { randomUUID } = require('node:crypto');
const { splitMessage } = require('./text-chat');

const commandDefinition = { name: 'fish', description: 'Private Fat Fish text chat and memory commands', options: [
  { type: 3, name: 'message', description: 'Question or /help, /remember, /recall, /search and other memory commands', required: true, max_length: 1024 },
] };
function loadTextConfig(env = process.env) {
  for (const key of ['FAT_FISH_TEXT_ENABLED', 'FAT_FISH_TEXT_REGISTER_COMMANDS'])
    if (env[key] !== undefined && !['true', 'false'].includes(env[key])) throw new Error(`Invalid ${key}`);
  const config = { enabled: env.FAT_FISH_TEXT_ENABLED === 'true', register: env.FAT_FISH_TEXT_REGISTER_COMMANDS === 'true',
    guildId: env.FAT_FISH_TEXT_GUILD_ID || '', channelId: env.FAT_FISH_TEXT_CHANNEL_ID || '',
    users: new Set((env.FAT_FISH_TEXT_USERS || '').split(',').filter(Boolean)), operators: new Set((env.FAT_FISH_TEXT_OPERATORS || '').split(',').filter(Boolean)) };
  if (config.enabled && (!config.guildId || !config.channelId || !config.users.size)) throw new Error('Text requires an explicit guild, channel and user allowlist');
  return config;
}
function createDiscordTextAdapter({ core, config, now = Date.now }) {
  const sessionId = randomUUID();
  return async interaction => {
    if (interaction.commandName !== 'fish') return false;
    const reply = content => interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } });
    if (!config.enabled || interaction.user?.bot || interaction.guildId !== config.guildId || interaction.channelId !== config.channelId || !config.users.has(interaction.user?.id)) {
      await reply('Text access is not authorized here.'); return true;
    }
    await interaction.deferReply({ flags: 64 });
    try {
      const response = await core.handle({ platform: 'discord-text', scope: { guildId: interaction.guildId, channelId: interaction.channelId, kind: 'private' },
        sessionId, userId: interaction.user.id, messageId: interaction.id,
        content: interaction.options.getString('message'), timestamp: now(), explicitInvocation: true,
        permissions: { interact: true, readMemory: true, manageMemory: config.operators.has(interaction.user.id), search: true } });
      const chunks = splitMessage(response.duplicate ? 'Duplicate message ignored.' : response.text, 1900);
      await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
      for (const content of chunks.slice(1)) await interaction.followUp({ content, flags: 64, allowedMentions: { parse: [] } });
    } catch {
      await interaction.editReply({ content: 'Operation unavailable or refused. Check /help, consent and local configuration; no success claimed.', allowedMentions: { parse: [] } });
    }
    return true;
  };
}
module.exports = { loadTextConfig, createDiscordTextAdapter, commandDefinition };
