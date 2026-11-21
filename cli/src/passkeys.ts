// SPDX-License-Identifier: Apache-2.0
import {
  PasskeyApprovalBroker,
  delegatedWorkerIdentity,
  resolveStoredIdentity,
  selectApplicationRelay,
} from '@acp/runtime';
export async function passkeysCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || !args.length) {
    console.log(
      'passkeys register|list|pending|poll <id> [--key file] [--relay URL] [--allow-private-relay]',
    );
    return;
  }
  const action = args[0];
  if (!['list', 'pending', 'register', 'poll'].includes(action))
    throw new Error('INVALID_PASSKEY_COMMAND');
  let offset = 1;
  if (action === 'poll') {
    if (!/^[a-f0-9]{64}$/.test(args[1] ?? '')) throw new Error('INVALID_APPROVAL_ID');
    offset++;
  }
  const seen = new Set<string>();
  for (let i = offset; i < args.length; i++) {
    const flag = args[i];
    if (!['--key', '--relay', '--allow-private-relay'].includes(flag) || seen.has(flag))
      throw new Error('INVALID_PASSKEY_OPTION');
    seen.add(flag);
    if (flag !== '--allow-private-relay' && (!args[++i] || args[i].startsWith('--')))
      throw new Error('MISSING_PASSKEY_OPTION_VALUE');
  }
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const identity = { explicitKeyPath: value('--key') };
  const owner =
    (await delegatedWorkerIdentity(identity))?.owner ??
    (await resolveStoredIdentity('worker', identity));
  const allowPrivateRelay = args.includes('--allow-private-relay');
  const relay = selectApplicationRelay({ explicit: value('--relay'), allowPrivateRelay }).relay;
  if (typeof relay !== 'string') throw new Error('APPROVAL_RELAY_REQUIRED');
  const broker = new PasskeyApprovalBroker(owner, { ...identity, relay, allowPrivateRelay });
  if (action === 'list') console.log(JSON.stringify(broker.listCredentials()));
  else if (action === 'pending') console.log(JSON.stringify(broker.listPending()));
  else if (action === 'poll' && args[1])
    console.log(JSON.stringify({ status: (await broker.poll(args[1])) ?? 'waiting' }));
  else if (action === 'register') {
    const link = await broker.requestRegistration();
    console.log(JSON.stringify(link));
    console.log(JSON.stringify({ status: await broker.wait(link.id) }));
  } else throw new Error('INVALID_PASSKEY_COMMAND');
}
