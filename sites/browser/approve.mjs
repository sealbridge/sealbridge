import {
  ownerApprovalChallenge,
  ownerApprovalBinding,
} from '../../packages/core/src/owner-approval.ts';
const $ = (id) => document.getElementById(id);
const literal = (value) =>
  String(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, (c) =>
    c
      .split('')
      .map((unit) => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0'))
      .join(''),
  );
const text = new TextEncoder();
const decode = (s) =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const encode = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
const sha = async (s) => encode(await crypto.subtle.digest('SHA-256', text.encode(s)));
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
// A second chat link may reuse this tab with only a different fragment.
window.addEventListener('hashchange', () => {
  if (location.hash) location.reload();
});
let request, key, id, relay, access, binding;
const fresh = () => {
  if (!request || request.expiresAt <= Date.now())
    throw new Error('This request has expired. Ask for a new request.');
};
async function json(suffix, body) {
  const response = await fetch(relay + '/v1/approvals/' + id + suffix, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: {
      authorization: 'Bearer ' + access,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('The encrypted request is unavailable or expired.');
  return response.json();
}
function serialize(credential) {
  const r = credential.response;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: r.attestationObject
      ? {
          clientDataJSON: encode(r.clientDataJSON),
          attestationObject: encode(r.attestationObject),
          transports: r.getTransports?.() ?? [],
        }
      : {
          clientDataJSON: encode(r.clientDataJSON),
          authenticatorData: encode(r.authenticatorData),
          signature: encode(r.signature),
          userHandle: r.userHandle ? encode(r.userHandle) : null,
        },
  };
}
async function authenticate(decision) {
  fresh();
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: decode(ownerApprovalChallenge(id, decision, binding)),
      rpId: request.rpID,
      allowCredentials: request.credentials.map((c) => ({ type: 'public-key', id: decode(c.id) })),
      userVerification: 'required',
      timeout: 60000,
    },
  });
  fresh();
  return serialize(assertion);
}
$('open').addEventListener('click', async () => {
  try {
    id = fragment.get('id');
    const secret = fragment.get('key');
    relay = new URL(fragment.get('relay')).origin;
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[\w-]{43}$/.test(secret) || !relay.startsWith('https://'))
      throw new Error('Invalid approval link.');
    const bytes = decode(secret),
      material = new Uint8Array([...bytes, ...text.encode('access')]);
    access = encode(await crypto.subtle.digest('SHA-256', material));
    key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt', 'encrypt']);
    const data = decode((await json('')).request),
      cipher = new Uint8Array([...data.slice(28), ...data.slice(12, 28)]);
    request = JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: data.slice(0, 12), additionalData: text.encode(id) },
          key,
          cipher,
        ),
      ),
    );
    if (request.id !== id || request.rpID !== location.hostname)
      throw new Error('This approval is for another site.');
    binding = ownerApprovalBinding(request);
    if (request.challenge !== ownerApprovalChallenge(id, 'approve', binding))
      throw new Error('Approval binding is invalid.');
    if (request.credentials.length) $('enrollment').textContent = '';
    if (!request.credentials.length)
      $('enrollment').textContent =
        request.noPasskeyMessage ??
        'No passkey is registered yet. Write tasks cannot be approved. Restart the worker and register within 10 minutes.';
    fresh();
    $('title').textContent =
      request.kind === 'registration'
        ? 'Register an owner passkey'
        : (request.details?.manifest?.task?.title ?? 'Approve this task gate');
    $('reason').textContent =
      request.kind === 'registration'
        ? request.details.reason
        : 'Approval needed: ' +
          (request.details?.approvalReasons?.join(', ') || 'owner decision') +
          '.';
    $('peer').textContent =
      'Peer: ' +
      literal(
        (request.details?.peerDisplayName ? request.details.peerDisplayName + ' / ' : '') +
          (request.details?.manifest?.requester?.ownerDid ?? request.ownerDid),
      );
    $('expiry').textContent = 'Expires: ' + new Date(request.expiresAt).toLocaleString();
    $('content').textContent = literal(
      JSON.stringify(
        {
          taskId: request.taskId,
          gate: request.gate,
          target: request.target,
          targetDigest: request.targetDigest,
          details: request.details,
        },
        null,
        2,
      ),
    );
    $('review').hidden = false;
    $('open').hidden = true;
    $('approve').textContent =
      request.kind === 'registration' ? 'Register passkey' : 'Approve with passkey';
    $('reject').hidden = request.kind === 'registration';
    $('status').textContent = 'Review the exact request below. Opening it has approved nothing.';
  } catch (e) {
    $('status').textContent = e.message;
  }
});
async function decide(decision) {
  $('approve').disabled = $('reject').disabled = true;
  try {
    fresh();
    let result = { id, decision };
    if (request.kind === 'registration') {
      const options = structuredClone(request.registration);
      options.challenge = decode(options.challenge);
      options.user.id = decode(options.user.id);
      options.excludeCredentials = options.excludeCredentials.map((c) => ({
        ...c,
        id: decode(c.id),
      }));
      const credential = await navigator.credentials.create({ publicKey: options });
      result.registration = serialize(credential);
      if (request.credentials.length)
        result.assertion = await authenticate(
          'register:' + (await sha(JSON.stringify(result.registration))),
        );
    } else result.assertion = await authenticate(decision);
    fresh();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: text.encode(id) },
        key,
        text.encode(JSON.stringify(result)),
      ),
    );
    const packed = new Uint8Array([...iv, ...cipher.slice(-16), ...cipher.slice(0, -16)]);
    await json('/results', { result: encode(packed) });
    if (request.kind === 'registration')
      $('enrollment').textContent =
        'Registration submitted. Check the worker passkey registered notice.';
    $('status').textContent =
      'Decision sent encrypted. Local Sealbridge must verify your passkey before taking action.';
  } catch (e) {
    $('status').textContent = 'No approval sent: ' + e.message;
    $('approve').disabled = $('reject').disabled = false;
  }
}
$('approve').addEventListener('click', () => decide('approve'));
$('reject').addEventListener('click', () => decide('reject'));
