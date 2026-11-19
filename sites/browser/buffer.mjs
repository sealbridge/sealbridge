import { Buffer as BrowserBuffer } from 'buffer';

// Only verification's Buffer operations are exposed. The package lacks base64url's alias.
export const Buffer = {
  from(value, encoding) {
    return BrowserBuffer.from(value, encoding === 'base64url' ? 'base64' : encoding);
  },
  alloc: BrowserBuffer.alloc,
  concat: BrowserBuffer.concat,
};
