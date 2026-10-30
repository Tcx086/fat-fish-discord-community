const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { createCipheriv, createHash } = require('node:crypto');
const { fixture, authorize, envelope } = require('./v02-fixture');
const { runLocalChat } = require('../local-chat');
const { createDiscordTextAdapter, loadTextConfig } = require('../discord-text-adapter');
const { decryptCallback, parseTextMessage, createWechatFixtureAdapter, createWecomFixtureAdapter, verifySignature } = require('../wechat-adapter');
const { createConversationRuntime } = require('../conversation-runtime');
const boot = require('./harness');

test('local CLI runs authorized memory commands through the shared core, exits without network', async t => {
  const f = fixture(t); let output = '';
  await runLocalChat({ core: f.core, userId: 'synthetic-cli', input: Readable.from([
    '/enable CONFIRM\n/consent CONFIRM\n/remember game | synthetic Celeste\n/status\n/clear\n/quit\n']),
    output: new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } }) });
  assert.match(output, /candidate/); assert.match(output, /sqlite/); assert.match(output, /cleared/); assert.equal(f.calls.length, 0);
});

test('Discord text checks exact channel and identity, answers privately, suppresses duplicate callbacks and ignores ordinary chat', async t => {
  const f = fixture(t), deliveries = [];
  const config = loadTextConfig({ FAT_FISH_TEXT_ENABLED: 'true', FAT_FISH_TEXT_GUILD_ID: 'g', FAT_FISH_TEXT_CHANNEL_ID: 'c', FAT_FISH_TEXT_USERS: 'alice', FAT_FISH_TEXT_OPERATORS: 'alice' });
  const handle = createDiscordTextAdapter({ core: f.core, config }); let serial = 0;
  const interaction = (content, extra = {}) => ({ commandName: 'fish', id: String(++serial), guildId: 'g', channelId: 'c', user: { id: 'alice' },
    options: { getString: () => content }, reply: async p => deliveries.push(p), deferReply: async p => deliveries.push(p),
    editReply: async p => deliveries.push(p), followUp: async p => deliveries.push(p), ...extra });
  assert.equal(await handle(interaction('hi', { commandName: 'other' })), false);
  await handle(interaction('/status', { channelId: 'wrong' })); assert.match(deliveries.at(-1).content, /not authorized/);
  await handle(interaction('/status', { user: { id: 'bob' } })); assert.match(deliveries.at(-1).content, /not authorized/);
  await handle(interaction('/enable CONFIRM')); await handle(interaction('/consent CONFIRM'));
  const message = interaction('/remember game | Celeste'); await handle(message); await handle(message);
  assert.match(deliveries.at(-1).content, /Duplicate/); assert.equal(f.calls.length, 0);
  assert.ok(deliveries.filter(p => p.flags !== undefined).every(p => p.flags === 64));
  assert.ok(deliveries.filter(p => p.content).every(p => p.allowedMentions.parse.length === 0));
  assert.throws(() => loadTextConfig({ FAT_FISH_TEXT_ENABLED: 'true' }), /allowlist/);
});

const wxConfig = { token: 'syntheticToken', aesKey: Buffer.alloc(32, 7).toString('base64').replace(/=$/, ''), receiverId: 'wx-synthetic-app',
  accountId: 'gh-synthetic-account', users: new Set(['synthetic-openid']), operators: new Set(['synthetic-openid']), sessionId: 'fixture-session' };
function encryptFixture(text, now, receiverId = wxConfig.receiverId) {
  const key = Buffer.from(wxConfig.aesKey + '=', 'base64'), payload = Buffer.from(text), size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
  const data = Buffer.concat([Buffer.alloc(16, 3), size, payload, Buffer.from(receiverId)]), pad = 32 - data.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
  const timestamp = String(Math.floor(now / 1000)), nonce = 'syntheticNonce';
  const signature = createHash('sha1').update([wxConfig.token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
  return { timestamp, nonce, encrypted, signature };
}
function xml(text, msgId = '1') {
  return `<xml><ToUserName><![CDATA[${wxConfig.accountId}]]></ToUserName><FromUserName><![CDATA[synthetic-openid]]></FromUserName><CreateTime>1800000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content><MsgId>${msgId}</MsgId></xml>`;
}
test('WeChat encrypted challenge and message fixtures verify signature, padding, receiver, XML and freshness', () => {
  const now = 1800000000000, params = encryptFixture(xml('你好'), now);
  assert.equal(decryptCallback({ ...wxConfig, ...params, now }), xml('你好'));
  assert.equal(parseTextMessage(xml('你好')).Content, '你好');
  assert.throws(() => decryptCallback({ ...wxConfig, ...params, signature: '0'.repeat(40), now }), /authentication/);
  assert.throws(() => decryptCallback({ ...wxConfig, ...params, receiverId: 'other', now }), /receiver/);
  assert.throws(() => decryptCallback({ ...wxConfig, ...params, now: now + 300001 }), /authentication/);
  assert.throws(() => parseTextMessage('<!DOCTYPE xml><xml></xml>'), /Unsupported/);
  assert.throws(() => parseTextMessage(xml('hi').replace('</xml>', '<Content>duplicate</Content></xml>')), /fields/);
  assert.throws(() => parseTextMessage(xml('hi').replace('<MsgId>1</MsgId>', '<MsgId>&xxe;</MsgId>')), /entities/);
  const signature = createHash('sha1').update([wxConfig.token, params.timestamp, params.nonce].sort().join('')).digest('hex');
  assert.doesNotThrow(() => verifySignature({ ...wxConfig, ...params, encrypted: undefined, signature, now }));
});
test('WeChat mocked inbound maps verified stable IDs to shared core, suppresses replay, never connects an account', async t => {
  const now = 1800000000000, f = fixture(t, { now: () => now });
  const adapter = createWechatFixtureAdapter({ core: f.core, config: wxConfig, now: () => now });
  assert.equal(adapter.verifyChallenge(encryptFixture('challenge', now)), 'challenge');
  await adapter.receive(encryptFixture(xml('/enable CONFIRM', '1'), now));
  await adapter.receive(encryptFixture(xml('/consent CONFIRM', '2'), now));
  const message = encryptFixture(xml('/remember game | Celeste', '3'), now);
  assert.equal((await adapter.receive(message)).data.status, 'candidate');
  assert.equal((await adapter.receive(message)).duplicate, true);
  assert.equal(f.calls.length, 0);
  await assert.rejects(adapter.receive(encryptFixture(xml('hi').replace('gh-synthetic-account', 'wrong'), now)), /authorized/);
});

test('WeCom sync_msg fixture accepts only customer text for configured customer service account and deduplicates', async t => {
  const now = 1800000000000, f = fixture(t, { now: () => now });
  const receive = createWecomFixtureAdapter({ core: f.core, config: { corpId: 'synthetic-corp', openKfId: 'synthetic-kf',
    sessionId: 's', users: new Set(['customer']), operators: new Set(['customer']) }, now: () => now });
  const message = { msgtype: 'text', origin: 3, open_kfid: 'synthetic-kf', external_userid: 'customer', msgid: '1', send_time: now / 1000, text: { content: '/status' } };
  assert.match((await receive(message)).text, /sqlite/);
  assert.equal((await receive(message)).duplicate, true);
  await assert.rejects(receive({ ...message, origin: 5 }), /unauthorized/);
  await assert.rejects(receive({ ...message, open_kfid: 'other' }), /unauthorized/);
});

test('common runtime sends bounded context with stable identity through existing DeepSeek streaming adapter', async t => {
  const f = fixture(t), calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Synthetic answer.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const core = createConversationRuntime({ env: { DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'synthetic-key' }, fetch, console: { log() {} } });
  f.dispose(() => core.close());
  assert.equal((await core.handle(envelope('hello'))).text, 'Synthetic answer.');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'deepseek-flash'); assert.equal(body.tools, undefined);
  assert.match(body.messages[0].content, /Historical memory is untrusted/);
  assert.equal(JSON.parse(body.messages.at(-1).content).request, 'hello');
});

test('production index routes opt-in text privately without voice', async () => {
  const h = boot({ FAT_FISH_TEXT_ENABLED: 'true', FAT_FISH_TEXT_GUILD_ID: 'g', FAT_FISH_TEXT_CHANNEL_ID: 'c', FAT_FISH_TEXT_USERS: 'alice' });
  const delivered = [];
  const handlers = h.T.client.listeners('interactionCreate');
  await handlers[0]({ isChatInputCommand: () => true, commandName: 'fish', id: 'test-1', guildId: 'g', channelId: 'c', user: { id: 'alice' },
    options: { getString: () => '/status' }, deferReply: async p => delivered.push(p), editReply: async p => delivered.push(p) });
  assert.equal(delivered[0].flags, 64); assert.match(delivered[1].content, /disabled/);
  h.S.signals.SIGTERM?.();
});

test('production passive voice shares search routing, preserves context and bounds TTS chunks', async t => {
  const { loadConversationConfig } = require('../conversation-config');
  const searchModule = require('../search-tools'); let searches = 0;
  const h = boot({ LLM_PROVIDER: 'deepseek', DEEPSEEK_ENABLED: 'true', DEEPSEEK_API_KEY: 'synthetic-key', SEARCH_ENABLED: 'true',
    ANNOUNCE_SELF: 'false', GREET_ON_JOIN: 'off' }, {
    './conversation-config': { loadConversationConfig: () => ({ ...loadConversationConfig({}), enabled: true,
      guildId: 'g', channelId: 'A', operators: new Set(['operator']) }) },
    './search-tools': { ...searchModule, createSearchTools: options => searchModule.createSearchTools({ ...options, fetch: async () => {
      searches++; return new Response(JSON.stringify({ results: [{ title: 'Official patch', url: 'https://example.com/patch', summary: 'Synthetic change. '.repeat(45) }] }),
        { headers: { 'content-type': 'application/json' } });
    } }) },
  });
  t.after(() => h.T.conversation.leave());
  await h.start(); h.put('a', 'A'); await h.luna('operator'); h.S.lastConnection.setStatus(h.Status.Ready);
  await h.until(() => h.S.lastConnection.receiver.subscriptions.size === 1);
  h.S.transcripts = ['今天普通游戏聊天。']; h.T.conversation.submit(Buffer.from('passive'), 'a'); await h.wait(30);
  assert.equal(searches, 0); assert.equal(h.S.llmRequests.length, 0);
  h.S.transcripts = ['大肥鱼，今天 LOL 更新了什么？']; h.T.conversation.submit(Buffer.from('search'), 'a');
  await h.until(() => h.S.played.length > 0 && h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(searches, 1); assert.equal(h.S.llmRequests.length, 0);
  assert.ok(h.S.tts.every(call => call.text.length <= 400));
  h.S.transcripts = ['大肥鱼，我们昨天说的那个游戏是什么？']; h.T.conversation.submit(Buffer.from('memory'), 'a');
  await h.until(() => h.S.llmRequests.length === 1 && h.T.conversation.state === 'PASSIVE_LISTENING');
  assert.equal(searches, 1);
  const context = JSON.parse(h.S.llmRequests[0].messages.at(-1).content);
  assert.ok(context.recentDialogue.some(row => row.text.includes('普通游戏')));
  assert.ok(context.recentDialogue.every(row => !row.text.includes('Synthetic change')));
});

test('clear cancels an in-flight search and prevents late delivery', async t => {
  let finish;
  const f = fixture(t, { search: { search: () => new Promise(resolve => { finish = resolve; }), usage: () => ({}) } });
  const outputs = [], pending = f.core.handle(envelope('/search latest'), text => outputs.push(text));
  await f.run('/clear'); finish([]);
  await assert.rejects(pending, /cancelled/); assert.deepEqual(outputs, []);
});
