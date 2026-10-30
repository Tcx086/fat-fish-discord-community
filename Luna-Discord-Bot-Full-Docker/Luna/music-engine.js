const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

function decodeAudio(checked, config) {
  const child = spawn(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'pipe', '-f', checked.format, '-i', 'pipe:0', '-map', '0:a:0', '-vn',
    '-t', String(config.maxDuration), '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const input = checked.handle.createReadStream();
  let closed = false, stopped = false;
  const completion = new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => { closed = true; resolve(code === 0); });
  });
  const fail = () => { if (!stopped) child.kill('SIGKILL'); };
  input.on('error', fail); child.stdin.on('error', fail); child.stdout.on('error', fail);
  input.pipe(child.stdin);
  return { stream: child.stdout, completion, close() {
    if (stopped) return; stopped = true;
    input.destroy(); child.stdin.destroy(); child.stdout.destroy();
    if (!closed) child.kill('SIGKILL');
  } };
}

function createMusicEngine({ voice, catalog, config, coordinator, decode = decodeAudio, timers = globalThis }) {
  const events = new EventEmitter(), queue = [];
  let current = null, state = 'IDLE', volume = config.volume, manualPause = false, lastError = null;
  const transition = next => { if (state !== next) { const previous = state; state = next; events.emit('state', { previous, state }); } };
  function cleanup(item) {
    if (!item) return;
    item.controller.abort(); timers.clearInterval(item.watchdog);
    coordinator.releaseMusic(item.player);
    item.player?.stop(true); item.resource?.playStream?.destroy(); item.decoder?.close();
  }
  function finish(item, error = null) {
    if (current !== item) return;
    current = null; cleanup(item);
    if (error) { lastError = error; transition('ERROR'); events.emit('trackError', { id: item.track.id, error }); }
    else events.emit('completed', { id: item.track.id });
    transition('IDLE'); startNext();
  }
  function coordinate() {
    const item = current;
    if (!item) return;
    const interrupted = coordinator.speechActive;
    if (manualPause || interrupted) {
      item.player?.pause(false); coordinator.releaseMusic(item.player);
      transition(manualPause ? 'PAUSED' : 'INTERRUPTED_FOR_SPEECH');
    } else if (!item.resource) transition('LOADING');
    else {
      try {
        if (!coordinator.musicOutput(item.player)) throw new Error('Music output unavailable');
        item.player.unpause();
        transition(item.player.state.status === voice.AudioPlayerStatus.Playing ? 'PLAYING' : 'LOADING');
      } catch { finish(item, 'Voice output unavailable'); }
    }
  }
  function startNext() {
    if (current || !queue.length || !coordinator.connection) return;
    const item = { ...queue.shift(), controller: new AbortController(), lastElapsed: 0, stalled: 0 };
    current = item; transition('LOADING'); coordinate();
    // Reserve the queue slot synchronously; asynchronous validation cannot reorder requests.
    void (async () => {
      const checked = await catalog.open(item.track, item.controller.signal);
      if (current !== item) { await checked.handle.close(); return; }
      item.track = { ...item.track, duration: checked.duration };
      try { item.decoder = decode(checked, config); }
      catch (error) { await checked.handle.close(); throw error; }
      item.decoder.completion.then(ok => { if (!ok && current === item) finish(item, 'Audio decoder failed'); })
        .catch(() => { if (current === item) finish(item, 'Audio decoder failed'); });
      const player = item.player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
      player.on('error', () => finish(item, 'Audio player failed'));
      player.on(voice.AudioPlayerStatus.Playing, coordinate);
      player.on(voice.AudioPlayerStatus.Idle, () => {
        // Decoder exit may arrive after the final PCM packet.
        item.decoder.completion.then(ok => finish(item, ok ? null : 'Audio decoder failed')).catch(() => finish(item, 'Audio decoder failed'));
      });
      item.resource = voice.createAudioResource(item.decoder.stream, { inputType: voice.StreamType.Raw, inlineVolume: true });
      item.resource.volume.setVolume(volume / 100);
      player.play(item.resource); coordinate();
    })().catch(() => { if (current === item) finish(item, 'Track unavailable or invalid'); });
    item.watchdog = timers.setInterval(() => {
      if (current !== item || manualPause || coordinator.speechActive) return;
      const elapsed = item.resource?.playbackDuration || 0;
      item.stalled = elapsed > item.lastElapsed ? 0 : item.stalled + 1; item.lastElapsed = elapsed;
      if (item.stalled >= 15 || elapsed > (item.track.duration + 2) * 1000) finish(item, 'Playback timed out');
    }, 1000); item.watchdog.unref?.();
  }
  function stop() {
    transition('STOPPING'); queue.length = 0; const old = current; current = null;
    cleanup(old); manualPause = false; lastError = null; transition('IDLE');
  }
  const engine = {
    events, coordinate, stop,
    play(name, requestedBy) {
      if (!coordinator.connection) throw new Error('请先加入授权语音频道。');
      const track = name ? catalog.resolve(name) : catalog.resolve(catalog.list()[0]?.id);
      if (!track) throw new Error('这首歌不在授权曲库中。');
      if (queue.length + (current ? 1 : 0) >= config.maxQueue) throw new Error('音乐队列已满。');
      queue.push({ track, requestedBy: String(requestedBy).slice(0, 64) }); startNext(); return track;
    },
    pause() { if (current) { manualPause = true; coordinate(); } },
    resume() { manualPause = false; coordinate(); },
    skip() { const old = current; current = null; cleanup(old); transition('IDLE'); startNext(); },
    setVolume(level) {
      if (!Number.isInteger(level) || level < 0 || level > 100) throw new Error('音量必须为 0–100。');
      volume = level; current?.resource?.volume.setVolume(level / 100);
    },
    snapshot() {
      const publicTrack = entry => entry ? { id: entry.track.id, title: entry.track.title, artist: entry.track.artist,
        duration: entry.track.duration, requestedBy: entry.requestedBy } : null;
      return { state, volume, current: publicTrack(current), elapsed: Math.min(current?.track.duration || 0,
        (current?.resource?.playbackDuration || 0) / 1000), queue: queue.map(publicTrack), lastError };
    },
  };
  coordinator.setMusic(engine); return engine;
}
module.exports = { createMusicEngine, decodeAudio };
