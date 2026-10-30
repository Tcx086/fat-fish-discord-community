// ─── Playback ─────────────────────────────────────────────────────────────────
//
// Everything Luna says in the voice channel goes through one queue, so
// answers, greetings and announcements never talk over each other.
//
// Responses from different speakers QUEUE and play in order. Each entry
// carries its speaker and that speaker's generation at queue time; when it
// comes up it re-checks, and is skipped if that speaker has since asked
// something newer. Another speaker asking does not affect it. This preserves
// barge-in for the person being answered while preventing speakers from
// cancelling each other.
//
// createPlayback({ voice, fetchTTS, console, lookahead }) → playback.
// voice is @discordjs/voice and fetchTTS is tts.js's, passed in so the test
// harness can fake them.

function createPlayback({ voice, fetchTTS, console, lookahead, timers = globalThis, coordinator = null }) {
  const { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus } = voice;

  let queueTail         = Promise.resolve();
  let currentPlayer     = null;
  let currentPlayerUser = null;              // who owns the entry currently playing
  const userGeneration  = new Map();         // userId -> that user's latest generation
  const responses       = new Map();         // userId -> their in-progress SpokenResponse
  const requests        = new Map();         // userId -> AbortController of their LLM request in flight
  const activePlayers   = new Map();         // player -> cancellation, including chimes
  let generationCounter = 0;                // never reuse a generation across resets
  let epoch = 0;

  // ─── Spoken responses ───────────────────────────────────────────────────────
  //
  // One answer being spoken. Sentences arrive from the LLM; TTS is requested for
  // the sentence about to play plus `lookahead` after it — enough for gapless
  // playback, without synthesising a whole long answer up front. cancel() aborts
  // requests in flight and discards audio that was fetched but not played: on a
  // barge-in, that work used to run to completion (and, on ElevenLabs, be billed)
  // for sentences nobody would hear.
  class SpokenResponse {
    constructor(render) {
      this.render     = render;
      this.sentences  = [];
      this.fetches    = [];   // Promise<stream|null>, by sentence index
      this.next       = 0;    // index of the next sentence to play
      this.controller = new AbortController();
    }

    get size() { return this.sentences.length; }

    add(sentence) {
      this.sentences.push(sentence);
      this._fill();
    }

    // Resolves to the audio stream for sentence `i` (or null if TTS failed) and
    // moves the lookahead window along.
    async take(i) {
      this.next = i + 1;
      this._fill();
      return this.fetches[i];
    }

    _fill() {
      if (this.controller.signal.aborted) return;
      const limit = Math.min(this.sentences.length, this.next + 1 + lookahead);
      for (let i = this.fetches.length; i < limit; i++) {
        const rendering = Promise.resolve().then(() => this.render(this.sentences[i], { signal: this.controller.signal }));
        // A prefetched failure may settle before take(); its consumer still receives the rejection.
        rendering.catch(() => {});
        this.fetches.push(rendering);
      }
    }

    cancel() {
      if (this.controller.signal.aborted) return;
      this.controller.abort();
      for (let i = this.next; i < this.fetches.length; i++) {
        this.fetches[i].then(stream => stream?.destroy()).catch(() => {});
      }
    }
  }

  // A speaker's answer starts: theirs to fill, cancelled if they're superseded.
  function startResponse(userId, render = fetchTTS) {
    const response = new SpokenResponse(render);
    responses.set(userId, response);
    return response;
  }

  function finishResponse(userId, response) {
    if (responses.get(userId) === response) responses.delete(userId);
  }

  // The LLM request answering a speaker, aborted if they're superseded.
  function trackRequest(userId, controller) { requests.set(userId, controller); }
  function untrackRequest(userId, controller) {
    if (requests.get(userId) === controller) requests.delete(userId);
  }

  // ─── Generations ────────────────────────────────────────────────────────────
  //
  // Generations are PER USER, not global.
  //
  // Previously a single global counter meant any new query cancelled every
  // pending sentence regardless of who asked. With several people in a channel
  // that silently ate questions: A asks, B asks, only B gets an answer and A
  // never learns why.
  //
  // Now each speaker has their own generation. A new query supersedes only that
  // speaker's own pending sentences; everyone else's stay queued and play in
  // turn.
  function nextGeneration(userId) {
    const g = ++generationCounter;
    userGeneration.set(userId, g);
    // Superseded: stop synthesising sentences of their answer that will now
    // never play.
    const superseded = responses.get(userId);
    if (superseded) {
      superseded.cancel();
      responses.delete(userId);
    }
    // ...and stop the LLM working on a question nobody is waiting for.
    const request = requests.get(userId);
    if (request) {
      request.abort();
      requests.delete(userId);
    }
    return g;
  }

  // The speaker's current generation (undefined before they first ask).
  const generationOf = userId => userGeneration.get(userId);
  // Whether `generation` is still the speaker's latest.
  const isCurrent = (userId, generation) => userGeneration.get(userId) === generation;

  // ─── The queue ──────────────────────────────────────────────────────────────

  function queue(fn, userId, generation) {
    const owner = epoch;
    queueTail = queueTail.then(async () => {
      // Stale only if THIS user has since asked something newer.
      if (owner !== epoch || userGeneration.get(userId) !== generation) return;
      currentPlayerUser = userId;
      try {
        await fn();
      } finally {
        if (owner === epoch) currentPlayerUser = null;
      }
    }).catch(() => {});
  }

  // Barge-in, scoped to one speaker.
  //
  // Saying the wake word again cuts off *your own* answer — the original intent.
  // It does not stop someone else mid-sentence. Note this deliberately does NOT
  // reset the queue: doing so would drop other speakers' queued responses,
  // which is the bug this replaces.
  function interrupt(userId) {
    const generation = nextGeneration(userId);

    if (currentPlayerUser === userId && currentPlayer) {
      // Let go of the player BEFORE stopping it: stop() fires its Idle event
      // at once, and play() reports a sentence that goes idle while still
      // ours as "cut short" — a false alarm on every interruption.
      const player = currentPlayer;
      currentPlayer = null;
      currentPlayerUser = null;
      activePlayers.get(player)?.();
    }

    return generation;
  }

  // ─── Playing audio ──────────────────────────────────────────────────────────
  //
  // fetchTTS() (tts.js) starts synthesis and returns a readable audio stream;
  // it is called as soon as a sentence is ready, even while a previous one is
  // still playing, so audio is ready with zero wait. play() subscribes the
  // stream to the Discord player and awaits completion; the queue calls it in
  // order.
  function play(passThrough, connection, { inputType = StreamType.Arbitrary, timeoutMs = 30000, volume, requireSourceEnd = false } = {}) {
    return new Promise(resolve => {
      let player, resource, subscription, timer;
      let settled = false;
      const finish = (ok = false, reason) => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timer);
        activePlayers.delete(player);
        if (currentPlayer === player) currentPlayer = null;
        player?.off(AudioPlayerStatus.Idle, onIdle);
        // Keep the error handler until the player is collected: late errors are harmless.
        try { player?.stop(true); } catch (_) {}
        subscription?.unsubscribe();
        resource?.playStream?.destroy();
        passThrough?.destroy?.();
        if (reason) console.error(`[audio] ${reason}`);
        resolve(ok);
      };
      const onIdle = () => {
        if (resource?.playStream && !resource.playStream.readableEnded) {
          console.warn('[audio] playback ended before the source stream ended');
          if (requireSourceEnd) return finish(false);
        }
        finish(true);
      };
      try {
        player = createAudioPlayer();
        player.on('error', () => finish(false, 'player error'));
        player.on(AudioPlayerStatus.Idle, onIdle);
        resource = createAudioResource(passThrough, { inputType, inlineVolume: volume !== undefined });
        if (volume !== undefined) resource.volume?.setVolume(volume);
        currentPlayer = player;
        activePlayers.set(player, () => finish());
        subscription = coordinator ? coordinator.speechOutput(player, connection) : connection.subscribe(player);
        if (!subscription) return finish(false, 'connection is unavailable');
        timer = timers.setTimeout(() => finish(false, 'playback timed out'), timeoutMs);
        player.play(resource);
      } catch {
        finish(false, 'playback setup failed');
      }
    });
  }

  // Says one line in its turn: queued under `userId` (a speaker, or an id of
  // its own like the intro's) at `generation` (a new one by default, which
  // supersedes that id's earlier lines). Skipped if `wanted()` is false by
  // the time it comes up — Luna left the channel, say. `render` makes the
  // audio (fetchTTS by default); `then` runs after it has played. Lines are
  // cached once rendered (tts-cache.js) unless `cache` is false: pass that for
  // one-off text, like a song title or someone's "!luna say".
  function say(text, { connection, userId, generation = nextGeneration(userId), wanted = () => true,
                       cache = true, render = line => fetchTTS(line, { cache }), then = null }) {
    const owner = epoch;
    queue(async () => {
      if (!wanted()) return;
      const pt = await render(text);
      if (owner !== epoch || !isCurrent(userId, generation) || !wanted()) { pt?.destroy(); return; }
      if (pt) await play(pt, connection);
      if (then && owner === epoch && isCurrent(userId, generation) && wanted()) then();
    }, userId, generation);
  }

  // A short sound (the chime), outside the queue.
  async function playSound(filePath, connection) {
    return play(filePath, connection, { timeoutMs: 5000, volume: 0.2 });
  }

  // Forgets everything (Luna left the voice channel): answers in progress are
  // cancelled, their LLM requests aborted, the queue emptied.
  function reset() {
    epoch++;
    for (const cancel of activePlayers.values()) cancel();
    for (const response of responses.values()) response.cancel();
    responses.clear();
    for (const request of requests.values()) request.abort();
    requests.clear();
    userGeneration.clear();
    queueTail         = Promise.resolve();
    currentPlayer     = null;
    currentPlayerUser = null;
  }

  return {
    queue, interrupt, nextGeneration, generationOf, isCurrent,
    say, play, playSound,
    startResponse, finishResponse, trackRequest, untrackRequest,
    reset,
    // Something is playing now (an answer, greeting or announcement).
    get busy() { return !!currentPlayer; },
    responses,
  };
}

module.exports = { createPlayback };
