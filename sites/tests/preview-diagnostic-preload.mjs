import { Server } from 'node:http';

// Loaded only by the test launcher. Deployed assets and normal preview are unchanged.
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === 'request') {
    args[1].setHeader('X-Sealbridge-Test-Preview', process.env.SEALBRIDGE_TEST_PREVIEW_NONCE);
  }
  return emit.call(this, event, ...args);
};
