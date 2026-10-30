// Text-only, opt-in observations; never attach stream data/readable consumers.
function createConversationDiagnostics({ enabled = false, metadataOnly = false, log = () => {}, now = Date.now }) {
  let current = null;
  const transcripts = new Map();
  const numbers = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) =>
    typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
  const emit = (event, fields = {}) => {
    if (!enabled) return;
    // Passive timing must never persist utterances, answers or nested text fields.
    const safe = metadataOnly ? { ...numbers(fields),
      ...(fields.memory ? { memory: numbers(fields.memory) } : {}) } : fields;
    log({ event, at: now(), ...safe });
  };
  function state(event) {
    if (!enabled) return;
    emit(event.event, event);
    if (event.event === 'accepted') {
      current = { sequence: event.sequence, speaker: event.speaker, generation: event.generation,
        transcript: transcripts.get(event.sequence), bytes: 0, firstAudio: false, firstContent: false };
      transcripts.delete(event.sequence);
    }
    if (event.event === 'state' && ['STOPPING', 'DISCONNECTED'].includes(event.state)) { current = null; transcripts.clear(); }
  }
  function transcript(data) {
    if (!enabled) return;
    if (metadataOnly) { emit('transcript', data); return; }
    transcripts.set(data.sequence, data);
    while (transcripts.size > 32) transcripts.delete(transcripts.keys().next().value);
    emit('transcript', data);
  }
  function responseObserver() {
    const owner = current;
    return data => {
      if (!enabled || !owner) return;
      if (data.event === 'ttsRequest' && owner === current) owner.bytes = 0;
      emit(data.event, { ...data, sequence: owner.sequence, stale: owner !== current });
    };
  }
  function firstContent() {
    if (enabled && current && !current.firstContent) {
      current.firstContent = true; emit('llmFirstContent', { sequence: current.sequence });
    }
  }
  function bodyChunk(chunk) {
    if (!enabled || !current || current.firstAudio) return;
    current.bytes += chunk.byteLength;
    if (current.bytes > 44) { current.firstAudio = true; emit('ttsFirstPcm', { sequence: current.sequence }); }
  }
  function observePlayer(player, statuses) {
    const owner = current;
    if (!enabled || !owner) return player;
    player.once(statuses.Playing, () => emit('playerPlaying', { sequence: owner.sequence, stale: owner !== current }));
    player.once(statuses.Idle, () => emit('playerIdle', { sequence: owner.sequence }));
    return player;
  }
  return { state, transcript, responseObserver, firstContent, bodyChunk, observePlayer, emit };
}
module.exports = { createConversationDiagnostics };
