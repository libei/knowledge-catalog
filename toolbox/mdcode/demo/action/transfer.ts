// Command-line driver for the TransferFunds action.
//
//   bun transfer.ts --list
//   bun transfer.ts "Alice Checking" "Bob Checking" 500
//
// The interesting output is a rejection: it is the constraint's own description,
// which is the same text an agent gets back and acts on.
//

import {listAccounts, transferFunds} from './action';

const args = process.argv.slice(2);

if (args[0] === '--list' || args.length === 0) {
  const accounts = await listAccounts();
  console.log('id  account          balance     floor    status');
  for (const a of accounts) {
    console.log(
        `${a.id.padEnd(3)} ${a.name.padEnd(16)} ${a.balance.padStart(9)} ${
            a.floor.padStart(8)}  ${a.status}`);
  }
  process.exit(0);
}

if (args.length !== 3) {
  console.error('usage: bun transfer.ts <source> <target> <amount>');
  console.error('       bun transfer.ts --list');
  process.exit(2);
}

const [source, target, amountText] = args;
const outcome = await transferFunds(source, target, Number(amountText));

switch (outcome.status) {
  case 'committed':
    console.log(
        `Committed. Checked ${outcome.checked.join(', ')}. ` +
        `Resolved ${source} -> ${outcome.refs.source.keys.join('/')}, ` +
        `${target} -> ${outcome.refs.target.keys.join('/')}.`);
    break;
  case 'rejected':
    console.log(`REJECTED (rolled back): ${outcome.message}`);
    process.exitCode = 1;
    break;
  case 'error':
    console.log(`ERROR: ${outcome.message}`);
    process.exitCode = 1;
    break;
}
