const { createHash } = require('node:crypto');
const { WAKE_RE, stripWakeWord, isJunkTranscript } = require('./voice-input');
const { abortable } = require('./deepseek');

function controlCommand(text) {
  const match = String(text).trim().match(/^deep\s*seek[\s,:.!?-]+(stop|end conversation|leave)[\s.!?]*$/i);
  return match ? { stop: 'interrupt', 'end conversation': 'end', leave: 'leave' }[match[1].toLowerCase()] : null;
}

// One ordered response worker; bounded parallel local STT keeps spoken controls available.
function createConversation({ guildId, channelId, isAuthorized, transcribe, respond, cancelPlayback,
  clearHistory, disconnect, hasParticipants = () => true, resetCapture = () => {}, timers = globalThis, now = Date.now,
  inactivityMs = 45000, maxPending = 6, maxAudioBytes = 960000, maxTextBytes = 1024,
  maxTurns = 12, sttTimeoutMs = 60000, onEvent = () => {}, onTranscript = () => {} }) {
  let state = 'DISCONNECTED', generation = 0, context = 0, connected = false, running = false;
  let idleTimer = null, lastActivity = 0, turnCount = 0, current = null, sequence = 0;
  const pending = [], sttQueue = [], jobs = new Set(), recent = new Map();
  const emit = (event, data = {}) => onEvent({ event, state, generation, at: now(), ...data });
  const transition = value => { state = value; emit('state'); };
  const clearTimer = () => { timers.clearTimeout(idleTimer); idleTimer = null; };
  const authorized = id => connected && isAuthorized(id);
  const occupied = () => jobs.size > 0 || running || pending.length > 0;
  function schedule() {
    clearTimer();
    if (!['ACTIVE', 'RESPONDING'].includes(state) || occupied()) return;
    const owner = generation;
    const handle = timers.setTimeout(() => {
      if (owner !== generation || idleTimer !== handle) return;
      idleTimer = null;
      if (state === 'ACTIVE' && !occupied()) end();
    }, Math.max(0, inactivityMs - (now() - lastActivity)));
    idleTimer = handle;
  }
  function cancel(target, clear) {
    transition('STOPPING'); generation++; clearTimer();
    current?.controller.abort(); current = null;
    for (const job of jobs) { job.controller.abort(); timers.clearTimeout(job.timer); }
    jobs.clear(); sttQueue.length = 0; pending.length = 0; recent.clear();
    cancelPlayback();
    if (clear) { context++; turnCount = 0; clearHistory(); }
    resetCapture(target); transition(target);
    if (target === 'ACTIVE') { lastActivity = now(); schedule(); }
  }
  function interrupt() { if (connected && state !== 'STANDBY') cancel('ACTIVE', false); }
  function end() { if (connected) cancel('STANDBY', true); }
  function leave() {
    connected = false; cancel('DISCONNECTED', true); disconnect();
  }
  function reset() { connected = false; cancel('DISCONNECTED', true); }
  function attach(guild, channel) {
    if (guild !== guildId || channel !== channelId) throw new Error('Unauthorized conversation channel');
    reset(); connected = true; transition('STANDBY');
  }
  function command(action) {
    emit('control', { action });
    if (action === 'interrupt') interrupt();
    else if (action === 'end') end();
    else if (action === 'leave' || action === 'stop') leave();
    else throw new Error('Unknown control');
  }
  async function drain() {
    if (running) return;
    running = true; clearTimer();
    try {
      while (pending.length && pending[0].ready) {
        const item = pending.shift();
        if (item.owner !== generation || !authorized(item.speaker) || !item.text) continue;
        let query = item.text;
        const wake = WAKE_RE.test(query);
        if (state === 'STANDBY' && !wake) continue;
        // shortcut: intelligible room speech can resemble an ACTIVE follow-up; assess intent/echo gating from live evidence.
        if (wake) query = stripWakeWord(query);
        if (query && isJunkTranscript(query)) continue;
        if (state === 'STANDBY') transition('ACTIVE');
        lastActivity = now();
        if (!query) continue;
        if (turnCount >= maxTurns) { emit('turn-limit'); end(); break; }
        turnCount++;
        const controller = new AbortController(), owner = generation;
        current = { controller, speaker: item.speaker };
        transition('RESPONDING');
        emit('accepted', { sequence: item.sequence, speaker: item.speaker });
        let delivered = false;
        try {
          delivered = await abortable(respond({ query: `Speaker ${item.speaker}: ${query}`,
            speaker: item.speaker, scopeId: JSON.stringify([channelId, context]),
            signal: controller.signal }), controller.signal);
        } catch { emit('response-cancelled-or-failed'); }
        if (owner !== generation) continue;
        current = null; transition('ACTIVE');
        if (delivered) lastActivity = now();
        emit('response-finished', { delivered: !!delivered });
      }
    } finally { running = false; schedule(); }
  }
  function startSTT() {
    while ([...jobs].filter(j => j.started).length < 2 && sttQueue.length) {
      const job = sttQueue.shift();
      if (!jobs.has(job)) continue;
      job.started = true;
      job.timer = timers.setTimeout(() => job.controller.abort(), sttTimeoutMs);
      const audio = job.audio; job.audio = null;
      let task;
      try { task = transcribe(audio, { signal: job.controller.signal }); }
      catch { task = Promise.resolve(null); }
      abortable(task, job.controller.signal).then(text => {
        if (job.owner !== generation || !authorized(job.speaker)) return;
        text = String(text || '').trim();
        onTranscript({ sequence: job.sequence, speaker: job.speaker, transcript: text.slice(0, maxTextBytes),
          speechEndedAt: job.speechEndedAt, admittedAt: job.admittedAt, sttCompletedAt: now() });
        const action = controlCommand(text);
        if (action) {
          emit('voice-control', { action, recognitionMs: now() - job.admittedAt,
            afterLastVoiceFrameMs: Number.isFinite(job.speechEndedAt) ? now() - job.speechEndedAt : null }); command(action); return;
        }
        const duplicate = 'text:' + job.speaker + ':' + text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const repeated = recent.has(duplicate) && now() - recent.get(duplicate) < 3000;
        const hallucination = /^(?:thank(?:s| you) for watching|please subscribe|music)[.!\s]*$/i.test(text);
        job.text = text && !repeated && !hallucination && Buffer.byteLength(text) <= maxTextBytes && !isJunkTranscript(text) ? text : null;
        if (job.text) recent.set(duplicate, now());
        while (recent.size > maxPending * 4) recent.delete(recent.keys().next().value);
      }).catch(() => {}).finally(() => {
        timers.clearTimeout(job.timer); jobs.delete(job); job.ready = true;
        startSTT(); void drain();
      });
    }
  }
  function submit(pcm, speaker, metadata = {}) {
    // A continuous stream of invalid STT must not keep admitting work past the idle deadline.
    if (state === 'ACTIVE' && now() - lastActivity >= inactivityMs && occupied()) return false;
    if (!authorized(speaker) || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length > maxAudioBytes ||
        metadata.forced || metadata.stale || pending.length + (current ? 1 : 0) >= maxPending) return false;
    // Same speaker + identical PCM within three seconds is a duplicate, not a new turn.
    const key = speaker + ':' + createHash('sha256').update(pcm).digest('hex');
    for (const [k, at] of recent) if (now() - at > 3000) recent.delete(k);
    if (recent.has(key)) return false;
    recent.set(key, now()); while (recent.size > maxPending * 4) recent.delete(recent.keys().next().value);
    const job = { speaker, audio: pcm, controller: new AbortController(), owner: generation,
      sequence: ++sequence, admittedAt: now(), speechEndedAt: metadata.speechEndedAt, ready: false, started: false, text: null };
    pending.push(job); jobs.add(job); sttQueue.push(job); clearTimer(); startSTT();
    return true; // Capture is free immediately; never wait here for LLM/TTS playback.
  }
  function memberLeft(speaker) {
    if (current?.speaker === speaker) interrupt();
    for (const job of jobs) if (job.speaker === speaker) {
      job.controller.abort();
      if (!job.started) {
        jobs.delete(job); job.audio = null;
        const index = sttQueue.indexOf(job); if (index !== -1) sttQueue.splice(index, 1);
      }
    }
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].speaker === speaker) pending.splice(i, 1);
    if (connected && !hasParticipants()) leave();
  }
  return { attach, reset, submit, command, interrupt, end, leave, memberLeft,
    get state() { return state; }, get generation() { return generation; },
    status: () => ({ state, generation, context, pending: pending.length, stt: jobs.size, turnCount }) };
}
module.exports = { createConversation, controlCommand };
