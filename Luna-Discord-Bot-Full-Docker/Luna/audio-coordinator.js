// Only this coordinator subscribes music/speech when the music engine is enabled.
function createAudioCoordinator() {
  let connection = null, epoch = 0, music = null, output = null;
  const holds = new Set();
  function reset() {
    epoch++; holds.clear(); output?.subscription?.unsubscribe(); output = null;
    connection = null; music?.stop();
  }
  function beginSpeech() {
    const token = {}, owner = epoch; holds.add(token); music?.coordinate();
    let done = false;
    return () => {
      if (done) return; done = true;
      if (owner !== epoch) return;
      holds.delete(token); music?.coordinate();
    };
  }
  return {
    reset, beginSpeech,
    bind(conn) { reset(); connection = conn; },
    setMusic(engine) { music = engine; },
    get connection() { return connection; },
    get speechActive() { return holds.size > 0; },
    musicOutput(player) {
      if (!connection || holds.size) return false;
      if (output?.player === player) return true;
      if (output) return false;
      const subscription = connection.subscribe(player);
      if (!subscription) throw new Error('Voice connection unavailable');
      output = { player, subscription }; return true;
    },
    releaseMusic(player) {
      if (output && output.player === player) { output.subscription.unsubscribe(); output = null; }
    },
    speechOutput(player, conn) {
      if (!connection || conn !== connection) throw new Error('Stale speech connection');
      const release = beginSpeech(), owner = epoch;
      try {
        if (output) throw new Error('Speech output already occupied');
        const subscription = connection.subscribe(player);
        if (!subscription) throw new Error('Voice connection unavailable');
        output = { player, subscription };
        return { unsubscribe() {
          if (owner === epoch && output?.player === player) { subscription.unsubscribe(); output = null; }
          release();
        } };
      } catch (error) { release(); throw error; }
    },
  };
}
module.exports = { createAudioCoordinator };
