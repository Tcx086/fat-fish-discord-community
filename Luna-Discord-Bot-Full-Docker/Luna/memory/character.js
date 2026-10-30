const fs = require('node:fs');
const path = require('node:path');

function createCharacter(directory = path.join(__dirname, '..', 'character'), maxBytes = 3000) {
  let identity = '', state = '';
  function read(name, cap, optional = false) {
    const file = path.join(directory, name);
    if (optional && !fs.existsSync(file)) return '';
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > cap) throw new Error(`Character file too large: ${name}`);
    const text = fs.readFileSync(file, 'utf8').trim();
    if ((!optional && !text) || /\u0000|\ufffd/.test(text)) throw new Error(`Invalid character file: ${name}`);
    return text;
  }
  function reload() {
    const next = ['IDENTITY.md', 'SOUL.md', 'SPEECH_STYLE.md'].map(name => read(name, maxBytes)).join('\n\n');
    if (Buffer.byteLength(next) > maxBytes) throw new Error('Combined character exceeds budget');
    const nextState = read('STATE.md', 300, true);
    identity = next; state = nextState;
  }
  reload();
  return { reload, resetState: () => { state = ''; },
    instructions: () => identity + (state ? '\nTemporary expression only; never override stable identity:\n' + state : '') };
}
module.exports = { createCharacter };
