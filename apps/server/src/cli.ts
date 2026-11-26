// Admin command line, for when nobody can sign in.
//   docker exec -it setryx reset-password <username>
//   docker exec -it setryx list-users
import { passwordSchema } from '@setryx/shared';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { deleteUserApiTokens } from './api-tokens.ts';
import { deleteUserSessions } from './sessions.ts';
import { forgetDevices } from './devices.ts';
import { findUserByUsername, listUsers, setPassword, updateUser } from './users.ts';

const [command, username] = process.argv.slice(2);
const db = openDb(loadConfig().dataDir);

/** Asks for a password without showing it. Null when there's no terminal to type into. */
function askHidden(question: string): Promise<string | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.resolve(null);
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let typed = '';
    const done = (value: string | null) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(typed);
        if (ch === '\u0003' || ch === '\u0004') return done(null); // Ctrl-C, Ctrl-D
        if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1);
        else if (ch >= ' ') typed += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The new password: from NEW_PASSWORD, or typed twice without being shown. */
async function newPassword(username: string): Promise<string | null> {
  if (process.env.NEW_PASSWORD) return process.env.NEW_PASSWORD;
  const first = await askHidden(`New password for ${username} (not shown): `);
  if (first === null) {
    console.error('Nothing to type the password into. Run it with a terminal: docker exec -it setryx reset-password <username>');
    return null;
  }
  const again = await askHidden('Type it again: ');
  if (again === null) return null;
  if (first !== again) {
    console.error('The two passwords don’t match. Nothing was changed.');
    return null;
  }
  return first;
}

async function main(): Promise<number> {
  switch (command) {
    case 'list-users': {
      for (const u of listUsers(db)) {
        console.log(`${u.username}\t${u.role}${u.disabled ? '\tturned off' : ''}`);
      }
      return 0;
    }
    case 'reset-password': {
      if (!username) {
        console.error('Usage: reset-password <username>');
        return 1;
      }
      const user = findUserByUsername(db, username.toLowerCase());
      if (!user) {
        console.error(`No user called "${username}". Run list-users to see who exists.`);
        return 1;
      }
      const password = await newPassword(user.username);
      if (password === null) return 1;
      const check = passwordSchema.safeParse(password);
      if (!check.success) {
        console.error(check.error.issues[0]?.message ?? 'Invalid password.');
        return 1;
      }
      await setPassword(db, user.id, password);
      if (user.disabled) updateUser(db, user.id, { disabled: false });
      deleteUserSessions(db, user.id);
      forgetDevices(db, user.id);
      deleteUserApiTokens(db, user.id);
      console.log(`Password changed for ${user.username}. They're signed out everywhere, their API tokens are revoked, and they can sign in with the new password.`);
      return 0;
    }
    default:
      console.error('Commands: reset-password <username>, list-users');
      return 1;
  }
}

const code = await main();
db.close();
process.exit(code);
