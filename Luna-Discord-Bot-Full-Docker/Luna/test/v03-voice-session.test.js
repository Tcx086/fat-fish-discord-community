const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoiceSession } = require('../voice-session');
const Status = { Ready: 'ready', Signalling: 'signalling', Connecting: 'connecting', Disconnected: 'disconnected', Destroyed: 'destroyed' };
function setup(requireChannelConfirmation = false) {
  const tasks = new Map(), connected = [], connections = []; let next = 0, conn, allowed = true;
  const timers = { setTimeout(fn) { tasks.set(++next, fn); return next; }, clearTimeout(id) { tasks.delete(id); } };
  const voice = { VoiceConnectionStatus: Status, joinVoiceChannel({ channelId }) {
    if (!conn || conn.state.status === Status.Destroyed) {
      conn = new EventEmitter(); conn.receiver = { subscriptions: new Map() };
      conn.setStatus = status => { conn.state = { status }; conn.emit(status); };
      conn.destroy = () => conn.setStatus(Status.Destroyed); connections.push(conn);
    }
    conn.channelId = channelId; conn.state = { status: Status.Signalling }; return conn;
  } };
  const channel = id => ({ id, members: { filter: () => ({ size: 1 }) } });
  const session = createVoiceSession({ voice, timers, requireChannelConfirmation, config: {}, console: { log() {}, warn() {} },
    isIgnored: () => false, validateChannel: () => allowed, onReset() {}, onConnected: (_conn, target) => connected.push(target.id) });
  const join = id => { const target = channel(id), guild = { id: 'g' }, c = session.join(target, guild); session.attach(c, target, null, guild); return c; };
  return { session, join, connected, connections, tasks, setAllowed: value => { allowed = value; } };
}

test('move invalidates old Ready/error/readiness callbacks even when transport is reused', () => {
  const f = setup(), conn = f.join('A'); conn.setStatus(Status.Ready);
  const oldReady = conn.listeners(Status.Ready)[0], oldError = conn.listeners('error')[0];
  conn.setStatus(Status.Connecting); const oldTimeout = [...f.tasks.values()][0];
  assert.equal(f.join('B'), conn); oldReady(); oldError(new Error('late')); oldTimeout();
  assert.equal(f.session.connection, null); assert.equal(f.session.channel.id, 'B');
  conn.setStatus(Status.Ready); assert.deepEqual(f.connected, ['A', 'B']);
  assert.equal(conn.listenerCount('error'), 1); f.session.leave('test'); assert.equal(f.tasks.size, 0);
});

test('move supersedes delayed A reconnect; queued recovery callbacks cannot restore A', () => {
  const f = setup(); f.join('A').setStatus(Status.Ready); f.session.reconnect();
  const oldRecovery = [...f.tasks.values()][0]; assert.equal(f.session.channel.id, 'A');
  f.join('B').setStatus(Status.Ready); oldRecovery();
  assert.deepEqual(f.connected, ['A', 'B']); assert.equal(f.connections.length, 2);
  assert.equal(f.session.channel.id, 'B'); f.session.leave('test'); assert.equal(f.tasks.size, 0);
});

test('reconnect rechecks permissions and fails disconnected; stop cancels destination readiness timeout', () => {
  const f = setup(); f.join('A').setStatus(Status.Ready); f.session.reconnect();
  const retry = [...f.tasks.values()][0]; f.setAllowed(false); retry();
  assert.equal(f.session.active, false); assert.equal(f.connections.length, 1);
  f.setAllowed(true); const c = f.join('B'), timeout = [...f.tasks.values()][0];
  f.session.leave('stop'); timeout(); c.setStatus(Status.Ready);
  assert.equal(f.session.active, false); assert.deepEqual(f.connected, ['A']);
});

test('Ready without target acknowledgement keeps its deadline; wrong-channel confirmation never opens capture', () => {
  const f = setup(true); f.join('A').setStatus(Status.Ready);
  assert.equal(f.connected.length, 0); assert.equal(f.tasks.size, 1);
  const timeout = [...f.tasks.values()][0]; timeout(); assert.equal(f.session.active, false);
  f.join('B').setStatus(Status.Ready); f.session.confirmChannel('g', 'A');
  assert.equal(f.connected.length, 0); assert.equal(f.tasks.size, 1);
  f.session.confirmChannel('g', 'B'); assert.deepEqual(f.connected, ['B']); assert.equal(f.tasks.size, 0);
  f.session.leave('test');
});
