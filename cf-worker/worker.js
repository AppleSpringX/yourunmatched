// CF Workers blocks fetch() to bare IPs ("Direct IP Access Not Allowed").
// We use a hostname (DuckDNS) that resolves to the wispbyte server IP.
const ORIGIN = 'http://yourunmatched.duckdns.org:9255';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = ORIGIN + url.pathname + url.search;
    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });
  },
};
