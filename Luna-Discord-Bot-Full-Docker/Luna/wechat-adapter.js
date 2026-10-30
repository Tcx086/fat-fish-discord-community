const { createHash, createDecipheriv, timingSafeEqual } = require('node:crypto');
const { bounded } = require('./memory/store');

function verifySignature({ token, timestamp, nonce, signature, encrypted, now = Date.now() }) {
  bounded(token, 256, 'callback token'); bounded(nonce, 128, 'nonce');
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300000 || !/^[a-f0-9]{40}$/i.test(signature))
    throw new Error('Invalid callback authentication');
  if (encrypted !== undefined) bounded(encrypted, 65536, 'encrypted body');
  const digest = createHash('sha1').update([token, timestamp, nonce, ...(encrypted === undefined ? [] : [encrypted])].sort().join('')).digest();
  if (!timingSafeEqual(digest, Buffer.from(signature, 'hex'))) throw new Error('Invalid callback authentication');
}

function decryptCallback({ aesKey, receiverId, encrypted, ...auth }) {
  verifySignature({ ...auth, encrypted });
  if (!/^[A-Za-z0-9+/]{43}$/.test(aesKey) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error('Invalid encrypted callback');
  const key = Buffer.from(aesKey + '=', 'base64'), cipher = Buffer.from(encrypted, 'base64');
  if (!cipher.length || cipher.length % 16 || cipher.length > 49152) throw new Error('Invalid encrypted callback');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(cipher), decipher.final()]);
  const pad = padded.at(-1);
  if (pad < 1 || pad > 32 || !padded.subarray(-pad).every(b => b === pad)) throw new Error('Invalid callback padding');
  const data = padded.subarray(0, -pad);
  if (data.length < 20) throw new Error('Invalid callback frame');
  const size = data.readUInt32BE(16);
  if (size > data.length - 20 || data.subarray(20 + size).toString('utf8') !== receiverId) throw new Error('Wrong callback receiver');
  return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(20, 20 + size));
}

// The official text-message fixture is flat XML; reject complex XML instead of adding an entity-capable parser.
function parseTextMessage(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 16384 || /<!DOCTYPE|<!ENTITY|<\?/i.test(xml)) throw new Error('Unsupported callback XML');
  const root = xml.trim().match(/^<xml>([\s\S]*)<\/xml>$/);
  if (!root) throw new Error('Invalid callback XML');
  const fields = {}, pattern = /<([A-Za-z]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<>]*))<\/\1>/g;
  let end = 0;
  for (const match of root[1].matchAll(pattern)) {
    if (root[1].slice(end, match.index).trim() || Object.hasOwn(fields, match[1])) throw new Error('Invalid callback fields');
    const value = match[2] ?? match[3];
    if (match[2] === undefined && /&/.test(value)) throw new Error('XML entities are not accepted');
    fields[match[1]] = value; end = match.index + match[0].length;
  }
  if (root[1].slice(end).trim() || fields.MsgType !== 'text' || !/^\d+$/.test(fields.CreateTime || '')) throw new Error('Unsupported message type');
  for (const key of ['FromUserName', 'ToUserName', 'MsgId', 'Content']) bounded(fields[key], key === 'Content' ? 1024 : 128, key);
  return fields;
}

// Mockable boundary only: no HTTP listener, access-token acquisition or real account transport is installed.
function createWechatFixtureAdapter({ core, config, now = Date.now }) {
  return {
    verifyChallenge(params) {
      return decryptCallback({ ...params, token: config.token, aesKey: config.aesKey, receiverId: config.receiverId, now: now() });
    },
    async receive(params) {
      const message = parseTextMessage(decryptCallback({ ...params, token: config.token, aesKey: config.aesKey, receiverId: config.receiverId, now: now() }));
      if (message.ToUserName !== config.accountId || !config.users.has(message.FromUserName)) throw new Error('WeChat identity not authorized');
      const timestamp = Number(message.CreateTime) * 1000;
      if (Math.abs(now() - timestamp) > 300000) throw new Error('Stale message');
      return core.handle({ platform: 'wechat-official', scope: { guildId: config.accountId, channelId: message.FromUserName, kind: 'private' },
        sessionId: config.sessionId, messageId: message.MsgId, userId: message.FromUserName, content: message.Content,
        timestamp, explicitInvocation: true, permissions: { interact: true, readMemory: true,
          manageMemory: config.operators.has(message.FromUserName), search: config.search === true } });
    },
  };
}

// Input comes only from a future authenticated sync_msg transport, never directly from callback JSON.
function createWecomFixtureAdapter({ core, config, now = Date.now }) {
  return async message => {
    if (message.msgtype !== 'text' || message.origin !== 3 || message.open_kfid !== config.openKfId ||
        !config.users.has(message.external_userid)) throw new Error('Unsupported or unauthorized customer message');
    bounded(message.msgid, 128, 'message id');
    if (!Number.isSafeInteger(message.send_time) || Math.abs(now() - message.send_time * 1000) > 300000) throw new Error('Stale customer message');
    return core.handle({ platform: 'wechat-kf', scope: { guildId: config.corpId, channelId: config.openKfId, kind: 'private' },
      sessionId: config.sessionId, messageId: message.msgid, userId: message.external_userid, content: message.text?.content,
      timestamp: message.send_time * 1000, explicitInvocation: true,
      permissions: { interact: true, readMemory: true, manageMemory: config.operators.has(message.external_userid), search: config.search === true } });
  };
}
module.exports = { verifySignature, decryptCallback, parseTextMessage, createWechatFixtureAdapter, createWecomFixtureAdapter };
