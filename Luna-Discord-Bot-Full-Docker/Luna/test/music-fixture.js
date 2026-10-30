const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMusicEngine } = require('../music-engine');
const { createAudioCoordinator } = require('../audio-coordinator');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fakeMusicVoice() {
  const players = [];
  const voice = {
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' }, StreamType: { Raw: 'raw' }, NoSubscriberBehavior: { Pause: 'pause' },
    createAudioPlayer() {
      const player = new EventEmitter(); player.state = { status: 'idle' };
      const set = status => { if (player.state.status === status) return; player.state = { status }; player.emit(status); };
      player.play = resource => { player.resource = resource; set('playing'); };
      player.stop = () => set('idle'); player.pause = () => set('paused'); player.unpause = () => set('playing');
      players.push(player); return player;
    },
    createAudioResource(stream) { return { playStream: stream, playbackDuration: 0,
      volume: { value: 1, setVolume(value) { this.value = value; } } }; },
  };
  return { voice, players };
}
function fixture(options = {}) {
  const { voice, players } = fakeMusicVoice(), decoders = [], opened = [];
  const tracks = ['a', 'b', 'c'].map(id => ({ id, title: `Song ${id}`, artist: 'Synthetic', duration: 2 }));
  const catalog = { resolve: name => tracks.find(t => t.id === name || t.title === name), list: () => tracks,
    async open(track, signal) { const entry = { track, signal, handle: { async close() { entry.closed = true; } }, duration: 2, format: 'wav' }; opened.push(entry); return entry; } };
  const decode = () => { const end = deferred(), stream = new PassThrough();
    const decoder = { stream, completion: end.promise, end: end.resolve, closed: false,
      close() { this.closed = true; stream.destroy(); end.resolve(false); } }; decoders.push(decoder); return decoder; };
  const coordinator = createAudioCoordinator();
  let subscription = null;
  const connection = { state: { status: 'ready' }, subscribe(player) {
    if (subscription) throw new Error('Competing subscription');
    const sub = { player, unsubscribe() { if (subscription === sub) subscription = null; } }; subscription = sub; return sub;
  } };
  coordinator.bind(connection);
  const engine = createMusicEngine({ voice, catalog, config: { volume: 30, maxQueue: 3 }, coordinator, decode, ...options });
  return { engine, coordinator, connection, voice, players, decoders, catalog, opened, get subscription() { return subscription; } };
}
const { wav } = require('../scripts/create-music-example');
module.exports = { fixture, fakeMusicVoice, deferred, tick, wav };
