/**
 * Maintenance commands, run on the Holorouter:
 *   node dist/cli.js create-admin <username> [first] [last]   (password read from HP_ADMIN_PASSWORD or prompted)
 *   node dist/cli.js reset-password <username>
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { get, run } from './db.js';
import { hashPassword } from './crypto.js';

/** Reads one line from the terminal without echoing it. Ctrl-C aborts; the terminal is always restored. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\u0004') return done(value ? undefined : new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.env.HP_ADMIN_PASSWORD) return process.env.HP_ADMIN_PASSWORD;
  if (!stdin.isTTY) {
    // Scripted use: take the first line of stdin, without a prompt.
    const rl = readline.createInterface({ input: stdin, terminal: false });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  const pw = await readHidden('Password (min 10 chars): ');
  const again = await readHidden('Repeat password: ');
  if (pw !== again) throw new Error('The passwords do not match');
  return pw;
}

const [cmd, username, first = 'Portal', last = 'Administrator'] = process.argv.slice(2);

if (cmd === 'create-admin' && username) {
  if (get('SELECT 1 FROM users WHERE username = ?', username)) {
    console.error(`User ${username} already exists`);
    process.exit(1);
  }
  const pw = await readPassword();
  if (pw.length < 10) throw new Error('Password must be at least 10 characters');
  run(
    "INSERT INTO users (username, first_name, last_name, role, auth_source, password_hash) VALUES (?, ?, ?, 'admin', 'local', ?)",
    username,
    first,
    last,
    await hashPassword(pw),
  );
  console.log(`Created administrator ${username}`);
} else if (cmd === 'reset-password' && username) {
  const pw = await readPassword();
  if (pw.length < 10) throw new Error('Password must be at least 10 characters');
  const res = run("UPDATE users SET password_hash = ?, enabled = 1 WHERE username = ? AND auth_source = 'local'", await hashPassword(pw), username);
  if (!res.changes) {
    console.error(`No local user ${username}`);
    process.exit(1);
  }
  run('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)', username);
  console.log(`Password reset for ${username}`);
} else {
  console.log('Usage: cli.js create-admin <username> [first] [last] | reset-password <username>');
  process.exit(2);
}
