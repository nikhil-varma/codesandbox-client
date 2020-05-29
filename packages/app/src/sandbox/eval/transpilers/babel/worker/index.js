import loadPolyfills from '@codesandbox/common/es/load-dynamic-polyfills';

require('app/config/polyfills');

self.importScripts(
  `${process.env.CODESANDBOX_HOST}/static/browserfs10/browserfs.min.js`
);

self.process = self.BrowserFS.BFSRequire('process');
self.Buffer = self.BrowserFS.BFSRequire('buffer').Buffer;

loadPolyfills().then(() => {
  // eslint-disable-next-line global-require
  require('./babel-worker');
});
