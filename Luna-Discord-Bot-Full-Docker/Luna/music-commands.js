const subcommands = [ ['play', '播放授权曲库歌曲'], ['pause', '暂停音乐'], ['resume', '继续音乐'],
  ['skip', '下一首'], ['stop', '停止音乐并清空队列'], ['queue', '查看音乐队列'],
  ['now-playing', '查看当前歌曲'], ['volume', '调整音乐音量'] ];
const commandDefinition = { name: 'music', description: '授权本地音乐播放', dm_permission: false,
  options: subcommands.map(([name, description]) => ({ type: 1, name, description,
    ...(name === 'play' ? { options: [{ type: 3, name: 'track', description: '授权曲库中的名称', required: true, autocomplete: true }] } : {}),
    ...(name === 'volume' ? { options: [{ type: 4, name: 'level', description: '音量 0–100', required: true, min_value: 0, max_value: 100 }] } : {}) })) };

// Input is wake-stripped only after passive-listener confirms a direct invocation.
function parseMusicCommand(question) {
  const text = String(question).normalize('NFKC').replace(/[。.!！?？]+$/u, '').trim();
  const exact = new Map([
    ['放首歌', 'play'], ['放一首歌', 'play'], ['播放音乐', 'play'], ['播放音樂', 'play'],
    ['下一首', 'skip'], ['跳过这首歌', 'skip'], ['暂停音乐', 'pause'], ['暫停音樂', 'pause'],
    ['继续播放', 'resume'], ['继续音乐', 'resume'], ['繼續播放', 'resume'],
    ['停止音乐', 'stop'], ['停止音樂', 'stop'], ['停止播放', 'stop'],
    ['现在放的是什么歌', 'now-playing'], ['这是什么歌', 'now-playing'], ['這是什麼歌', 'now-playing'],
    ['音乐队列', 'queue'], ['pause music', 'pause'], ['resume music', 'resume'], ['stop music', 'stop'],
    ['skip song', 'skip'], ['what song is this', 'now-playing'],
  ]);
  if (exact.has(text.toLowerCase())) return { action: exact.get(text.toLowerCase()) };
  const play = text.match(/^(?:播放|放首歌\s*|放一首\s*|play\s+)(.{1,100})$/iu);
  return play ? { action: 'play', track: play[1].trim() } : null;
}
function describeMusic(snapshot) {
  if (!snapshot.current) return snapshot.lastError ? `音乐已停止：${snapshot.lastError}。` : '现在没有播放音乐。';
  const { title, artist, duration } = snapshot.current;
  return `${snapshot.state}：${title} — ${artist}（${Math.floor(snapshot.elapsed)}/${Math.ceil(duration)}秒），音量 ${snapshot.volume}%。`;
}
function createMusicCommands({ engine, catalog, guildId, session, isAllowed, isChannelAllowed = () => true }) {
  function authorized(guild, userId, member) {
    return guild === guildId && session.connection?.state?.status === 'ready' && session.channel?.guild?.id === guildId &&
      session.channel?.members?.get(userId) && !member?.user?.bot && member?.voice?.channelId === session.channel.id &&
      isChannelAllowed(session.channel, member) && isAllowed(userId, member);
  }
  function execute(command, userId) {
    switch (command.action) {
      case 'play': { const track = engine.play(command.track, userId); return `已加入队列：${track.title} — ${track.artist}。`; }
      case 'pause': engine.pause(); return '音乐已暂停。';
      case 'resume': engine.resume(); return '已继续音乐；助手说话时会等待。';
      case 'skip': engine.skip(); return '已跳到下一首。';
      case 'stop': engine.stop(); return '音乐已停止，队列已清空。';
      case 'volume': engine.setVolume(command.level); return `音乐音量：${command.level}%。`;
      case 'now-playing': return describeMusic(engine.snapshot());
      case 'queue': { const snapshot = engine.snapshot(); return `${describeMusic(snapshot)}\n待播：${snapshot.queue.length ?
        snapshot.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`).join('；') : '空'}${snapshot.queue.length > 10 ? `（共 ${snapshot.queue.length} 首）` : ''}`; }
      default: throw new Error('未知音乐指令。');
    }
  }
  return {
    voice(command, userId) {
      const member = session.channel?.members?.get(userId);
      if (!authorized(session.channel?.guild?.id, userId, member)) return '请在当前授权语音频道使用音乐指令。';
      try { return execute(command, userId); } catch (error) { return error.message; }
    },
    async interaction(interaction) {
      if (interaction.commandName !== 'music') return false;
      const autocomplete = interaction.isAutocomplete?.();
      if (!autocomplete && !interaction.isChatInputCommand?.()) return false;
      const member = interaction.guild?.members?.cache?.get(interaction.user.id) || interaction.member;
      const allowed = authorized(interaction.guildId, interaction.user.id, member);
      if (autocomplete) {
        await interaction.respond(allowed ? catalog.list(interaction.options.getFocused()).slice(0, 25)
          .map(t => ({ name: `${t.title} — ${t.artist}`.slice(0, 100), value: t.id })) : []).catch(() => {});
        return true;
      }
      let content = '请在当前授权语音频道使用音乐指令。';
      if (allowed) {
        try { content = execute({ action: interaction.options.getSubcommand(), track: interaction.options.getString('track'),
          level: interaction.options.getInteger('level') }, interaction.user.id); }
        catch (error) { content = error.message; }
      }
      await interaction.reply({ content, flags: 64, allowedMentions: { parse: [] } }).catch(() => {});
      return true;
    },
  };
}
module.exports = { commandDefinition, parseMusicCommand, describeMusic, createMusicCommands };
