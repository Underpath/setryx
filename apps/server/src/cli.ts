// Admin command line, for when nobody can sign in.
//   docker exec -it setryx reset-password <username>
//   docker exec -it setryx list-users
import { createInterface } from 'node:readline/promises';
import { passwordSchema } from '@setryx/shared';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { deleteUserApiTokens } from './api-tokens.ts';
import { deleteUserSessions } from './sessions.ts';
import { forgetDevices } from './devices.ts';
import { findUserByUsername, listUsers, setPassword, updateUser } from './users.ts';

const [command, username] = process.argv.slice(2);
const db = openDb(loadConfig().dataDir);

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
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
      const password = process.env.NEW_PASSWORD ?? (await ask(`New password for ${user.username}: `));
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
