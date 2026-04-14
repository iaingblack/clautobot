import { EventEmitter } from 'node:events';

// In-process pub/sub between the poller and the chat SSE endpoint.
// Both live in the same Node process (poller.js starts web.js), so a
// module-level EventEmitter is enough — no redis, no ipc.
//
// Events emitted:
//   workflow-update  { ticketKey, status, workflow }
export const bus = new EventEmitter();
bus.setMaxListeners(100);
