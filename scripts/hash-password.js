#!/usr/bin/env node
// Generates a bcrypt hash for use as AUTH_PASSWORD_HASH in your .env file.
// Usage: npm run hash-password

const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter password: ', (password) => {
  if (!password) { console.error('Password cannot be empty.'); process.exit(1); }
  const hash = bcrypt.hashSync(password.trim(), 12);
  console.log('\nAdd this to your .env file:\n');
  console.log(`AUTH_PASSWORD_HASH=${hash}`);
  console.log('');
  rl.close();
});
