// Minimal .env reader/writer: keeps unknown lines and comments intact.
const fs = require('fs');
const path = require('path');

function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

function serializeValue(value) {
  const str = String(value ?? '');
  return /[\s#"'=]/.test(str) ? `"${str.replace(/"/g, '')}"` : str;
}

class EnvFile {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    try {
      return parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  get(key) {
    return this.read()[key] || '';
  }

  // Updates or appends the given keys; an empty value removes the key.
  update(values) {
    let lines = [];
    try {
      lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/);
    } catch {
      lines = ['# Steam Randomizer settings'];
    }
    const pending = { ...values };
    lines = lines.filter((line) => {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !(m && m[1] in pending && !pending[m[1]]);
    }).map((line) => {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m && m[1] in pending) {
        const next = `${m[1]}=${serializeValue(pending[m[1]])}`;
        delete pending[m[1]];
        return next;
      }
      return line;
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const [key, value] of Object.entries(pending)) {
      if (value) lines.push(`${key}=${serializeValue(value)}`);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, lines.join('\n') + '\n', 'utf8');
  }
}

module.exports = { EnvFile, parse };
