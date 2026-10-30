const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const DAY = 86400000;
function bounded(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid memory limit');
  return value;
}

// One instance belongs to exactly one guild/channel. No caller supplies SQL or a different scope.
class MemoryStore {
  constructor({ filename, guildId, channelId, now = Date.now, retentionMs = DAY, summaryRetentionMs = DAY }) {
    this.guild = bounded(guildId, 128, 'guild'); this.channel = bounded(channelId, 128, 'channel');
    this.now = now; this.closed = false;
    integer(retentionMs, 60000, 30 * DAY);
    this.summaryRetentionMs = integer(summaryRetentionMs, 60000, 30 * DAY);
    const { DatabaseSync } = require('node:sqlite');
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=25; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version === 0) this.transaction(() => this.db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')));
      else if (![1, 2].includes(version)) throw new Error('Unsupported memory schema');
      if (version < 2) this.transaction(() => this.db.exec(fs.readFileSync(path.join(__dirname, 'v2.sql'), 'utf8')));
      if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Memory integrity check failed');
      this.db.prepare('INSERT OR IGNORE INTO channel_settings(guild,channel,retention_ms,updated_at) VALUES(?,?,?,?)')
        .run(this.guild, this.channel, retentionMs, now());
      this.cleanup();
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settings() { return this.db.prepare('SELECT * FROM channel_settings WHERE guild=? AND channel=?').get(this.guild, this.channel); }
  consent(speaker) { return this.db.prepare('SELECT * FROM consent_records WHERE guild=? AND channel=? AND speaker=?').get(this.guild, this.channel, bounded(speaker, 128, 'speaker')); }
  ticket(speaker, startedAt) {
    const settings = this.settings(), consent = this.consent(speaker);
    if (!settings.enabled || !consent?.granted || !Number.isSafeInteger(startedAt) || startedAt < consent.since || startedAt < settings.updated_at) return null;
    return { epoch: settings.epoch, version: consent.version };
  }
  canRead(speaker) { return !!(this.settings().enabled && this.consent(speaker)?.granted); }
  enable(actor, retentionMs = DAY) {
    bounded(actor, 128, 'actor'); integer(retentionMs, 60000, 30 * DAY);
    return this.transaction(() => {
      this.db.prepare('UPDATE channel_settings SET enabled=1,epoch=epoch+1,retention_ms=?,updated_at=?,authorized_by=? WHERE guild=? AND channel=?')
        .run(retentionMs, this.now(), actor, this.guild, this.channel);
      // Every enablement is a fresh notice/choice boundary, even if the administrator repeats the command.
      this.db.prepare('UPDATE consent_records SET granted=0 WHERE guild=? AND channel=?').run(this.guild, this.channel);
      this.clearHistory();
    });
  }
  disable() {
    this.transaction(() => {
      this.db.prepare('UPDATE channel_settings SET enabled=0,epoch=epoch+1,updated_at=? WHERE guild=? AND channel=?').run(this.now(), this.guild, this.channel);
      this.db.prepare('UPDATE consent_records SET granted=0 WHERE guild=? AND channel=?').run(this.guild, this.channel);
      this.clearHistory();
    });
  }
  grant(speaker) {
    if (!this.settings().enabled) throw new Error('History is disabled');
    bounded(speaker, 128, 'speaker');
    if (this.consent(speaker)?.granted) return;
    this.db.prepare(`INSERT INTO consent_records VALUES(?,?,?,?,?,?) ON CONFLICT(guild,channel,speaker)
      DO UPDATE SET granted=1,version=excluded.version,since=excluded.since`)
      .run(this.guild, this.channel, speaker, 1, randomUUID(), this.now());
  }
  audit(reason, affected) {
    this.db.prepare('INSERT INTO deletion_audit(guild,channel,at,reason,affected) VALUES(?,?,?,?,?)').run(this.guild, this.channel, this.now(), reason, affected);
  }
  withdraw(speaker) {
    bounded(speaker, 128, 'speaker');
    this.transaction(() => {
      this.db.prepare('UPDATE consent_records SET granted=0,version=?,since=? WHERE guild=? AND channel=? AND speaker=?')
        .run(randomUUID(), this.now(), this.guild, this.channel, speaker);
      const removed = this.db.prepare('DELETE FROM transcript_events WHERE guild=? AND channel=? AND speaker=?').run(this.guild, this.channel, speaker).changes;
      this.db.prepare("UPDATE memories SET status='deleted',content='',topic_key='',author='',approved_by=NULL,updated_at=? WHERE guild=? AND channel=? AND author=?")
        .run(this.now(), this.guild, this.channel, speaker);
      this.db.prepare('DELETE FROM consent_records WHERE guild=? AND channel=? AND speaker=?').run(this.guild, this.channel, speaker);
      this.audit('withdrawal', removed);
    });
  }
  startSession() {
    const id = randomUUID();
    this.db.prepare('INSERT INTO conversation_sessions VALUES(?,?,?,?,NULL)').run(id, this.guild, this.channel, this.now());
    return id;
  }
  endSession(id) { if (id) this.db.prepare('UPDATE conversation_sessions SET ended_at=? WHERE id=? AND guild=? AND channel=?').run(this.now(), id, this.guild, this.channel); }
  append({ session, sequence, speaker, timestamp, startedAt, text, ticket, provenance = 'local-stt' }) {
    bounded(provenance, 64, 'provenance');
    bounded(text, 1024, 'transcript'); integer(sequence, 1, Number.MAX_SAFE_INTEGER);
    // Capture clocks can jump backwards; uncertain timing must not authorize durable collection.
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > timestamp || timestamp > this.now()) return false;
    return this.transaction(() => {
      const current = this.ticket(speaker, startedAt);
      if (!ticket || !current || ticket.epoch !== current.epoch || ticket.version !== current.version) return false;
      const settings = this.settings();
      if (timestamp + settings.retention_ms <= this.now()) return false;
      if (!this.db.prepare('SELECT 1 FROM conversation_sessions WHERE id=? AND guild=? AND channel=? AND ended_at IS NULL').get(session, this.guild, this.channel)) return false;
      const eventKey = `${session}:${sequence}`;
      const result = this.db.prepare(`INSERT OR IGNORE INTO transcript_events
        (event_key,session,guild,channel,speaker,event_at,sequence,text,collected_at,expires_at,consent_version,provenance)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventKey, session, this.guild, this.channel, speaker, timestamp, sequence, text, this.now(), timestamp + settings.retention_ms, current.version, provenance);
      return result.changes === 1;
    });
  }
  clearHistory() {
    const removed = this.db.prepare('DELETE FROM transcript_events WHERE guild=? AND channel=?').run(this.guild, this.channel).changes;
    this.db.prepare("UPDATE memories SET status='deleted',content='',topic_key='',author='',approved_by=NULL,updated_at=? WHERE guild=? AND channel=? AND kind='summary'")
      .run(this.now(), this.guild, this.channel);
    this.audit('clear-history', removed);
  }
  cleanup(limit = 25) {
    integer(limit, 1, 100);
    return this.transaction(() => {
      this.db.prepare('DELETE FROM account_link_offers WHERE expires_at<=?').run(this.now());
      this.db.prepare('DELETE FROM processed_messages WHERE expires_at<=?').run(this.now());
      // Expiry is global maintenance, including scopes no longer active in this process.
      const removed = this.db.prepare('DELETE FROM transcript_events WHERE id IN (SELECT id FROM transcript_events WHERE expires_at<=? LIMIT ?)')
        .run(this.now(), limit).changes;
      this.db.prepare("UPDATE memories SET status='deleted',content='',topic_key='',author='',approved_by=NULL,updated_at=? WHERE expires_at<=? AND status!='deleted'")
        .run(this.now(), this.now());
      this.db.prepare("DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM memories WHERE status='deleted')").run();
      this.db.prepare('DELETE FROM conversation_sessions WHERE guild=? AND channel=? AND started_at<? AND id NOT IN (SELECT session FROM transcript_events)')
        .run(this.guild, this.channel, this.now() - DAY);
      this.db.prepare("DELETE FROM memories WHERE guild=? AND channel=? AND status IN ('deleted','rejected','superseded') AND updated_at<?")
        .run(this.guild, this.channel, this.now() - 30 * DAY);
      this.db.prepare('DELETE FROM deletion_audit WHERE guild=? AND channel=? AND at<?').run(this.guild, this.channel, this.now() - 30 * DAY);
      if (removed) this.audit('expiry', removed);
      return removed;
    });
  }
  episodes({ viewer, terms = [], from = 0, to = this.now() + 1, limit = 40, own = false, cursorId = Number.MAX_SAFE_INTEGER }) {
    integer(limit, 1, 200); integer(from, 0, Number.MAX_SAFE_INTEGER); integer(to, from, Number.MAX_SAFE_INTEGER);
    if (!own && !this.canRead(viewer)) return [];
    bounded(viewer, 128, 'viewer');
    integer(cursorId, 1, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(terms) || terms.length > 16 || terms.some(t => typeof t !== 'string' || t.length > 64)) throw new Error('Invalid search terms');
    const long = terms.filter(t => [...t].length >= 3), short = terms.filter(t => [...t].length < 3);
    const base = `SELECT e.* FROM transcript_events e JOIN consent_records c
      ON c.guild=e.guild AND c.channel=e.channel AND c.speaker=e.speaker
      WHERE e.guild=? AND e.channel=? AND e.event_at>=? AND e.event_at<? AND e.expires_at>?
      AND c.granted=1 AND c.version=e.consent_version ${own ? 'AND e.speaker=? AND e.id<?' : ''}`;
    const args = [this.guild, this.channel, from, to, this.now(), ...(own ? [viewer, cursorId] : [])];
    let rows = [];
    if (long.length) {
      const match = long.map(t => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
      rows = this.db.prepare(base + ' AND e.id IN (SELECT rowid FROM transcript_search WHERE transcript_search MATCH ?) ORDER BY e.event_at DESC,e.id DESC LIMIT ?').all(...args, match, limit);
    }
    // shortcut: short CJK terms scan only the latest 500 eligible rows; widen or add a bigram index if measured recall requires it.
    if (short.length || !terms.length) {
      const recent = this.db.prepare(base + (own ? ' ORDER BY e.id DESC LIMIT ?' : ' ORDER BY e.event_at DESC,e.id DESC LIMIT ?')).all(...args, terms.length ? 500 : limit);
      rows.push(...recent.filter(r => !terms.length || short.some(t => r.text.toLowerCase().includes(t.toLowerCase()))));
    }
    return [...new Map(rows.map(r => [r.id, r])).values()].sort((a, b) => own ? b.id - a.id : b.event_at - a.event_at || b.id - a.id).slice(0, limit);
  }
  eligibleMemory(row) {
    if (!row || row.guild !== this.guild || row.channel !== this.channel || (row.expires_at !== null && row.expires_at <= this.now())) return false;
    if (row.kind === 'summary') {
      const sources = this.db.prepare(`SELECT e.expires_at,c.granted,c.version,e.consent_version FROM memory_sources s
        JOIN transcript_events e ON e.id=s.event_id JOIN consent_records c ON c.guild=e.guild AND c.channel=e.channel AND c.speaker=e.speaker
        WHERE s.memory_id=?`).all(row.id);
      return sources.length > 0 && sources.every(s => s.expires_at > this.now() && s.granted && s.version === s.consent_version);
    }
    return true;
  }
  memories(viewer, status = 'approved', after = '') {
    if (!this.canRead(viewer)) return [];
    const order = status === 'approved' ? 'updated_at DESC,id' : 'id';
    return this.db.prepare(`SELECT * FROM memories WHERE guild=? AND channel=? AND status=? AND id>? AND (expires_at IS NULL OR expires_at>?) ORDER BY ${order} LIMIT 200`)
      .all(this.guild, this.channel, status, after, this.now()).filter(r => this.eligibleMemory(r));
  }
  candidate({ author, content, topic, expiresAt = null, privateScope = false }) {
    bounded(author, 128, 'author'); bounded(content, 1600, 'memory'); bounded(topic, 80, 'topic');
    if (expiresAt !== null) integer(expiresAt, this.now() + 1, this.now() + 365 * DAY);
    const id = randomUUID(), at = this.now();
    this.db.prepare(`INSERT INTO memories(id,guild,channel,kind,status,content,topic_key,author,created_at,updated_at,expires_at,source_at,provenance)
      VALUES(?,?,?,'curated','candidate',?,?,?,?,?,?,?,?)`)
      .run(id, this.guild, this.channel, content, topic.normalize('NFKC').toLowerCase().trim(), author, at, at, expiresAt, at,
        privateScope ? 'owner-submitted private fact/preference; non-sensitive owner review required' : 'owner-submitted; non-personal review required');
    return id;
  }
  review(id, decision, actor, { supersedes = null, nonSensitive = false } = {}) {
    bounded(id, 128, 'memory id'); bounded(actor, 128, 'actor');
    if (!['approved', 'rejected', 'deleted'].includes(decision)) throw new Error('Invalid review decision');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM memories WHERE id=? AND guild=? AND channel=?').get(id, this.guild, this.channel);
      if (!row) throw new Error('Memory not found');
      if (decision === 'approved') {
        if (row.status !== 'candidate' || !this.eligibleMemory(row) || !nonSensitive) throw new Error('Review requires a current candidate and explicit non-sensitive attestation');
        const conflicts = this.db.prepare("SELECT id FROM memories WHERE guild=? AND channel=? AND kind=? AND status='approved' AND (topic_key=? OR content=?)")
          .all(this.guild, this.channel, row.kind, row.topic_key, row.content);
        if (conflicts.length && (conflicts.length !== 1 || conflicts[0].id !== supersedes)) throw new Error('Conflict: specify the approved memory to supersede');
        if (supersedes && !conflicts.some(r => r.id === supersedes)) throw new Error('Supersession does not match conflict');
        if (supersedes) this.db.prepare("UPDATE memories SET status='superseded',content='',topic_key='',updated_at=? WHERE id=?").run(this.now(), supersedes);
      }
      this.db.prepare('UPDATE memories SET status=?,content=?,updated_at=?,approved_by=?,supersedes=? WHERE id=?')
        .run(decision, decision === 'approved' ? row.content : '', this.now(), actor, supersedes, id);
      if (decision !== 'approved') {
        this.db.prepare("UPDATE memories SET topic_key='',author='',approved_by=NULL WHERE id=?").run(id);
        this.db.prepare('DELETE FROM memory_sources WHERE memory_id=?').run(id);
      }
    });
  }
  async summarize({ viewer, summarizer, from = 0, to = this.now() + 1 }) {
    if (!summarizer) return { status: 'pending', reason: 'No authorized summarizer configured' };
    const rows = this.episodes({ viewer, from, to, limit: 40 });
    const selected = []; let bytes = 0;
    for (const row of rows.reverse()) { bytes += Buffer.byteLength(row.text); if (bytes > 12000) break; selected.push(row); }
    if (!selected.length) return { status: 'pending', reason: 'No eligible sources' };
    const id = createHash('sha256').update(JSON.stringify([this.guild, this.channel, selected.map(r => r.event_key)])).digest('hex');
    const existing = this.db.prepare('SELECT status FROM memories WHERE id=?').get(id);
    if (existing) return { id, status: existing.status };
    if (this.summarizing) return { status: 'pending', reason: 'Summary already running' };
    this.summarizing = true;
    const controller = new AbortController();
    let timeout;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => summarizer(selected.map(r => ({ id: r.id, text: r.text, timestamp: r.event_at })), { signal: controller.signal })),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Summary timed out')); }, 5000); }),
      ]);
      if (!Array.isArray(result) || !result.length || result.length > 12) throw new Error('Invalid summary');
      const kinds = ['confirmed_statement', 'tentative_plan', 'opinion', 'joke_or_hypothetical', 'unknown_or_conflicting'];
      for (const point of result) {
        bounded(point.text, 300, 'summary point');
        if (!kinds.includes(point.kind) || !Array.isArray(point.sources) || !point.sources.length || point.sources.length > 40 || point.sources.some(id => !selected.some(r => r.id === id))) throw new Error('Invalid summary provenance');
      }
      const content = JSON.stringify(result);
      if (Buffer.byteLength(content) > 6000) throw new Error('Summary too large');
      return this.transaction(() => {
        if (!this.canRead(viewer)) return { status: 'pending', reason: 'Consent changed' };
        for (const source of selected) {
          const row = this.db.prepare('SELECT * FROM transcript_events WHERE id=? AND expires_at>?').get(source.id, this.now());
          if (!row || !this.consent(row.speaker)?.granted || this.consent(row.speaker).version !== source.consent_version) return { status: 'pending', reason: 'Sources changed' };
        }
        const at = this.now();
        this.db.prepare(`INSERT OR IGNORE INTO memories(id,guild,channel,kind,status,content,topic_key,author,created_at,updated_at,expires_at,source_at,provenance)
          VALUES(?,?,?,'summary','candidate',?,?,?,?,?,?,?,'review-required; source statements are not verified facts')`)
          .run(id, this.guild, this.channel, content, id, viewer, at, at, Math.min(at + this.summaryRetentionMs, ...selected.map(r => r.expires_at)), selected[0].event_at);
        for (const row of selected) this.db.prepare('INSERT OR IGNORE INTO memory_sources VALUES(?,?)').run(id, row.id);
        return { id, status: 'candidate' };
      });
    } finally { clearTimeout(timeout); controller.abort(); this.summarizing = false; }
  }
  exportOwn(viewer, cursorId = Number.MAX_SAFE_INTEGER, memoryCursor = '') {
    bounded(viewer, 128, 'viewer');
    return { episodes: this.episodes({ viewer, own: true, cursorId, limit: 200 }),
      memories: this.db.prepare("SELECT * FROM memories WHERE guild=? AND channel=? AND author=? AND kind='curated' AND id>? AND status IN ('candidate','approved') AND (expires_at IS NULL OR expires_at>?) ORDER BY id LIMIT 200")
        .all(this.guild, this.channel, viewer, memoryCursor, this.now()).filter(r => this.eligibleMemory(r)) };
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
module.exports = { MemoryStore, DAY, bounded, integer };
