// Only the OS terminal boundary is adapted for portable subprocess tests.
// CLI prompts, stdin answers, network, stores and session routing remain real.
if (process.env.SEALBRIDGE_TEST_TERMINAL === '1') {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
}
// Windows child.kill(SIGTERM) terminates forcibly; dispatch the same handler via
// IPC there. Unix tests send an actual OS SIGTERM. IPC must not hold Node open.
process.on('message', message => {
  if (message === 'SIGTERM' && process.platform === 'win32') process.emit('SIGTERM');
});
process.channel?.unref();
