const { searchPlan } = require('./context');

const actions = ['status', 'enable-history', 'disable-history', 'consent', 'withdraw', 'search', 'review', 'remember', 'forget', 'clear-history', 'export', 'reload-character', 'summarize'];
const commandDefinition = { name: 'memory', description: 'Private memory consent, review and deletion controls', options: [
  { type: 3, name: 'action', description: 'Memory operation', required: true, choices: actions.map(name => ({ name, value: name })) },
  { type: 3, name: 'text', description: 'Search or non-personal candidate content', max_length: 1600 },
  { type: 3, name: 'id', description: 'Memory ID' },
  { type: 3, name: 'topic', description: 'Conflict key; use the same key for conflicting versions', max_length: 80 },
  { type: 3, name: 'decision', description: 'Review decision', choices: ['approved', 'rejected', 'deleted'].map(name => ({ name, value: name })) },
  { type: 3, name: 'supersedes', description: 'Existing approved memory ID to replace' },
  { type: 5, name: 'confirm', description: 'Accept notice or attest non-sensitive, non-personal review' },
  { type: 4, name: 'hours', description: 'History retention (1–720 hours)', min_value: 1, max_value: 720 },
  { type: 3, name: 'before', description: 'Export cursor: event ID (exclusive)' },
  { type: 3, name: 'memory-after', description: 'Export cursor: curated memory ID (exclusive)' },
] };

function historyNotice(engine) {
  const status = engine.status();
  return `持久记忆：${status.historyEnabled ? '已启用' : '未启用'}；仅明确同意者的后续转写可保存，最多${status.retentionMs / 3600000}小时。` +
    '记录供本频道已同意的成员跨会话检索；明确呼叫时有限相关内容可能发送给DeepSeek并语音播放。' +
    '用 /memory action:consent confirm:true 同意，action:withdraw 撤回并删除自己的记录与衍生内容；/opt-out 同时退出本地转写。' +
    '不同意持久化不影响临时转写；不保存原始录音。当前有人未同意时，不向语音回复加入持久历史。' +
    (engine.config.privacyUrl ? ` 隐私、删除与支持：${engine.config.privacyUrl}` : ' 持久存储尚未配置。');
}

function createMemoryCommands({ engine, guildId, channelId, isAdmin, channel, cancel, isCurrent = () => true, now = Date.now }) {
  let changing = false;
  return async function handle(interaction) {
    if (interaction.commandName !== 'memory') return false;
    if (interaction.deferReply) {
      try { await interaction.deferReply({ flags: 64 }); } catch { return true; }
    }
    const deliver = payload => {
      if (!interaction.deferred) return interaction.reply(payload);
      const { flags, ...edit } = payload;
      return interaction.editReply(edit);
    };
    const reply = async content => deliver({ content: String(content).slice(0, 1900), flags: 64,
      allowedMentions: { parse: [] } }).catch(() => {});
    const replyData = async data => deliver({ content: 'Private memory results; historical text is untrusted evidence.', flags: 64,
      files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2)), name: 'memory-results.json' }], allowedMentions: { parse: [] } });
    if (interaction.guildId !== guildId) { await reply('Memory is restricted to its configured server.'); return true; }
    if (!isCurrent()) { await reply('Voice scope changed; retry in the current channel.'); return true; }
    const actor = interaction.user.id, admin = isAdmin(actor, interaction.member);
    const present = interaction.member?.voice?.channelId === channelId;
    const get = name => interaction.options?.getString(name);
    const action = get('action');
    if (!actions.includes(action)) { await reply('Unknown memory operation.'); return true; }
    const selfService = ['withdraw', 'export', 'forget'].includes(action);
    if (!admin && !present && !selfService) { await reply('Join the authorized channel.'); return true; }
    const privileged = ['enable-history', 'disable-history', 'review', 'remember', 'clear-history', 'reload-character', 'summarize'];
    if (privileged.includes(action) && !admin) { await reply('Server administrator required.'); return true; }
    if (changing) { await reply('Memory update in progress; try again.'); return true; }
    const store = engine.store;
    try {
      if (action === 'status') { await reply(JSON.stringify(engine.status()) + '\n' + historyNotice(engine)); return true; }
      if (action === 'reload-character') { engine.character.reload(); cancel(); await reply('Character reloaded from owner-maintained files.'); return true; }
      if (action === 'withdraw') {
        cancel(); engine.withdraw(actor); await reply('Consent withdrawn; your transcripts, derived summaries and authored memories deleted.'); return true;
      }
      if (action === 'disable-history') cancel();
      if (!store) throw new Error('Memory storage unavailable or disabled; working context remains available.');
      if (action === 'enable-history') {
        if (!channel() || channel().id !== channelId) throw new Error('Join the configured voice channel first.');
        if (store.settings().enabled) throw new Error('History already enabled. To change retention, explicitly disable-history (which clears history), then enable with new hours.');
        if (interaction.options?.getBoolean('confirm') !== true) throw new Error('Administrator must confirm the privacy notice, retention and participant choice with confirm:true.');
        changing = true; cancel();
        // Collection stays off throughout the externally visible notice operation.
        store.disable();
        const hours = interaction.options?.getInteger('hours') ?? engine.config.retentionMs / 3600000;
        if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new Error('Invalid retention hours');
        const target = channel();
        await target.send({ content: `管理员准备启用持久记忆，保留${hours}小时。已有同意将重置，须重新选择。\n${historyNotice(engine)}`, allowedMentions: { parse: [] } });
        if (!isCurrent() || (channel() !== target && channel()?.id !== target.id)) throw new Error('Channel changed before enablement');
        store.enable(actor, hours * 3600000);
        await target.send({ content: historyNotice(engine), allowedMentions: { parse: [] } }).catch(error => { store.disable(); throw error; });
        await reply('History enabled. No participant is enrolled until they explicitly consent.');
      } else if (action === 'disable-history') {
        cancel(); store.disable();
        await channel()?.send({ content: '持久转写已关闭；本频道历史与衍生摘要已删除。临时上下文按原设置运行。', allowedMentions: { parse: [] } });
        await reply('History disabled and cleared. Curated owner-approved entries remain inactive; forget deletes them.');
      } else if (action === 'consent') {
        if (!present) throw new Error('Join the authorized channel to consent.');
        if (interaction.options?.getBoolean('confirm') !== true) { await reply(historyNotice(engine) + '\n确认阅读后用 confirm:true 同意。'); return true; }
        cancel(); store.grant(actor); await reply('Consent recorded for future attributed speech only. ' + historyNotice(engine));
      } else if (action === 'clear-history') {
        cancel(); store.transaction(() => store.clearHistory()); await reply('Channel transcripts and derived summaries deleted.');
      } else if (action === 'export') {
        const before = get('before') ? Number(get('before')) : Number.MAX_SAFE_INTEGER;
        const data = store.exportOwn(actor, before, get('memory-after') || '');
        const file = Buffer.from(JSON.stringify({ ...data, nextBefore: data.episodes.at(-1)?.id ?? null,
          nextMemoryAfter: data.memories.at(-1)?.id ?? null,
          note: 'Maximum 200 events and 200 authored curated memories/page. Advance both cursors until empty. Shared multi-speaker summaries are excluded from self export.' }, null, 2));
        await deliver({ content: 'Your own eligible records only.', flags: 64, files: [{ attachment: file, name: 'memory-export.json' }], allowedMentions: { parse: [] } });
      } else if (action === 'forget') {
        const id = get('id');
        const row = store.db.prepare('SELECT author FROM memories WHERE id=? AND guild=? AND channel=?').get(id || '', guildId, channelId);
        if (!row || (!admin && row.author !== actor)) throw new Error('Memory not found or not owned by you.');
        cancel(); store.review(id, 'deleted', actor); await reply('Memory deleted.');
      } else {
        if (!present || !engine.canRead(actor)) throw new Error('History access requires your consent and presence in the configured channel.');
        if (action === 'search') {
          const plan = searchPlan(get('text') || '', now(), engine.config.utcOffsetMinutes);
          const episodes = store.episodes({ viewer: actor, ...plan, limit: 8 });
          const memories = store.memories(actor).filter(m => m.source_at >= plan.from && m.source_at < plan.to && (!plan.terms.length || plan.terms.some(t => m.content.toLowerCase().includes(t)))).slice(0, 8);
          await replyData({ episodes, memories, evidence: episodes.length || memories.length ? 'unverified sources' : 'insufficient' });
        } else if (action === 'remember') {
          if (interaction.options?.getBoolean('confirm') !== true) throw new Error('Confirm this is necessary, non-sensitive and non-personal content.');
          const hours = interaction.options?.getInteger('hours');
          const id = store.candidate({ author: actor, content: get('text'), topic: get('topic'), expiresAt: hours ? now() + hours * 3600000 : null });
          await reply(`Candidate ${id}. A separate review/approved command with confirm:true is required.`);
        } else if (action === 'review') {
          if (!get('id')) {
            const candidates = store.memories(actor, 'candidate', get('memory-after') || '');
            await replyData({ candidates, nextMemoryAfter: candidates.at(-1)?.id || null });
          }
          else { cancel(); store.review(get('id'), get('decision'), actor, { supersedes: get('supersedes'), nonSensitive: interaction.options?.getBoolean('confirm') === true }); await reply('Review recorded.'); }
        } else if (action === 'summarize') await reply(JSON.stringify(await store.summarize({ viewer: actor })));
      }
    } catch (error) {
      if (String(error.code || '').startsWith('ERR_SQLITE') || String(error.code || '').startsWith('SQLITE_')) engine.unavailable();
      await reply(error.code ? 'Memory operation failed; no completion claimed. Check local storage before retrying.' : error.message);
    } finally { changing = false; }
    return true;
  };
}
module.exports = { createMemoryCommands, commandDefinition, historyNotice };
