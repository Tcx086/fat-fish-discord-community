const { invocation } = require('./passive-listener');

const stringOption = (name, description) => ({ type: 3, name, description, required: true, max_length: name === 'phrase' ? 1024 : 32 });
const commandDefinition = { name: 'wake', description: 'Configure and test the local Whisper wake phrase', options: [
  { type: 1, name: 'set', description: 'Set a distinctive Chinese/English wake phrase', options: [{ ...stringOption('phrase', 'Wake phrase (up to 32 characters)'), max_length: 64 }] },
  { type: 1, name: 'mode', description: 'Choose wake matching mode', options: [{ ...stringOption('mode', 'Matching mode'), choices: [
    { name: 'direct', value: 'direct' }, { name: 'anywhere', value: 'anywhere' }] }] },
  { type: 1, name: 'show', description: 'Show this server’s wake settings' },
  { type: 1, name: 'reset', description: 'Restore 大肥鱼 and direct address' },
  { type: 1, name: 'test', description: 'Test a transcript locally; never run a control or inference', options: [stringOption('phrase', 'Synthetic transcript to test')] },
] };

function createWakeCommands({ settings, guildId, isOperator, onChange = () => {} }) {
  return async interaction => {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'wake') return false;
    const reply = content => interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } }).catch(() => {});
    if (!interaction.guildId || interaction.guildId !== guildId) { await reply('Wake settings are restricted to the configured server.'); return true; }
    try {
      const action = interaction.options.getSubcommand();
      if (!['set', 'mode', 'reset', 'show', 'test'].includes(action)) throw new Error('Unknown wake subcommand.');
      if (['set', 'mode', 'reset'].includes(action) && !isOperator(interaction.user.id) && interaction.memberPermissions?.has('Administrator') !== true &&
          interaction.member?.permissions?.has?.('Administrator') !== true) {
        await reply('Administrator or configured operator required.'); return true;
      }
      let value = settings.get(interaction.guildId);
      if (action === 'test') {
        const called = invocation(interaction.options.getString('phrase', true), value);
        await reply(called ? `Matched; ${called.action ? 'control: ' + called.action : called.music ? 'music: ' + called.music.action : 'reply'}. Test only; nothing executed.` : 'No match. Test only; nothing executed.');
        return true;
      }
      if (action === 'set') value = settings.set(interaction.guildId, { ...value, phrase: interaction.options.getString('phrase', true) });
      if (action === 'mode') value = settings.set(interaction.guildId, { ...value, mode: interaction.options.getString('mode', true) });
      if (action === 'reset') value = settings.reset(interaction.guildId);
      if (action !== 'show') onChange();
      await reply(JSON.stringify(value));
    } catch (error) { await reply(error.message); }
    return true;
  };
}

module.exports = { createWakeCommands, commandDefinition };
