const { DeepSeekError, safeError, abortable } = require('./deepseek');

// Existing queue/player own Discord resources; this layer owns one delivered LLM turn.
async function answerDeepSeek({ llm, playback, session, fetchTTS, console, query, connection, userId, signal, scopeId, onEvent = () => {} }) {
  const owner = session.generation;
  if (!connection || session.connection !== connection || signal?.aborted) return false;
  const generation = playback.interrupt(userId), controller = new AbortController();
  const externalAbort = () => controller.abort(new DeepSeekError('CANCELLED'));
  signal?.addEventListener('abort', externalAbort, { once: true });
  const current = () => !controller.signal.aborted && session.generation === owner &&
    session.connection === connection && playback.isCurrent(userId, generation);
  const deadline = setTimeout(() => controller.abort(new DeepSeekError('TIMEOUT')), 120000);
  playback.trackRequest(userId, controller);
  let turn, response;
  const abort = () => controller.abort(new DeepSeekError('CANCELLED'));
  try {
    turn = llm.createTurn({ guildId: session.channel?.guild?.id || connection.joinConfig?.guildId,
      sessionId: scopeId === undefined ? owner : `${owner}:${scopeId}`, userId, query, signal: controller.signal });
    turn.signal.addEventListener('abort', abort, { once: true });
    response = playback.startResponse(userId, async (sentence, { signal: prefetchSignal }) => {
      if (!current()) throw new DeepSeekError('CANCELLED');
      const renderSignal = AbortSignal.any([controller.signal, prefetchSignal]);
      onEvent({ event: 'ttsRequest', text: sentence });
      const rendering = Promise.resolve(fetchTTS(sentence, { signal: renderSignal, cache: false }))
        .then(audio => { if (!current() || renderSignal.aborted) { audio?.destroy(); return null; } return audio; });
      return abortable(rendering, renderSignal);
    });
    const deliveries = [];
    for await (const sentence of turn.stream()) {
      if (!current()) throw new DeepSeekError('CANCELLED');
      const index = response.size;
      response.add(sentence);
      // queue() can drop stale callbacks. Aborting the wait also covers those callbacks.
      const delivery = new Promise((resolve, reject) => {
        playback.queue(async () => {
          try {
            if (!current()) throw new DeepSeekError('CANCELLED');
            const audio = await abortable(response.take(index), controller.signal);
            if (!current()) { audio?.destroy(); throw new DeepSeekError('CANCELLED'); }
            const played = audio && await playback.play(audio, connection, { requireSourceEnd: true });
            onEvent({ event: 'playbackFinished', ok: !!played });
            if (!played || !current() || !turn.acknowledge(sentence))
              throw new DeepSeekError('DELIVERY');
            resolve();
          } catch (e) { controller.abort(safeError(e)); reject(safeError(e)); }
        }, userId, generation);
      });
      delivery.catch(() => {});
      deliveries.push(delivery);
    }
    await abortable(Promise.all(deliveries), controller.signal);
    return current() && turn.commit();
  } catch (e) {
    const error = safeError(controller.signal.aborted ? controller.signal.reason : e);
    console.warn(`[deepseek] ${error.code}: ${error.message}`);
    return false;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', externalAbort);
    turn?.signal.removeEventListener('abort', abort);
    // Only interrupt our own generation; a newer answer may already own playback.
    if (playback.isCurrent(userId, generation)) playback.interrupt(userId);
    controller.abort(); response?.cancel();
    if (response) playback.finishResponse(userId, response);
    turn?.dispose(); playback.untrackRequest(userId, controller);
  }
}
module.exports = { answerDeepSeek };
