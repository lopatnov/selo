import { WS_URL } from './api';

/**
 * One WebSocket for the whole application.
 *
 * Opening a socket per component (or per mount) produced a reconnect storm:
 * every closed socket scheduled its own `setTimeout(connect, …)`, so route
 * changes and React's double-mount in development multiplied the loops and
 * the server saw many connections for a single open page.
 *
 * Here the socket is a module-level singleton:
 *  - `subscribe(handler)` / `unsubscribe` are reference counted;
 *  - at most one reconnect timer exists at a time, with exponential backoff;
 *  - the socket is closed only when nobody is listening, and even then after a
 *    short grace period so a route change does not kill and reopen it;
 *  - components never touch `new WebSocket` themselves.
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// A component that unmounts as part of a route change must not tear the socket
// down if the next page subscribes within the same tick.
const SHUTDOWN_GRACE_MS = 300;

const listeners = new Set();
const statusListeners = new Set();

let socket = null;
let reconnectTimer = null;
let shutdownTimer = null;
let attempt = 0;
// 'idle' | 'connecting' | 'online' | 'reconnecting'
let status = 'idle';

function setStatus(next) {
  if (status === next) return;
  status = next;
  statusListeners.forEach(listener => {
    try {
      listener(next);
    } catch (error) {
      console.error('WebSocket status listener failed:', error);
    }
  });
}

function dispatch(type, data) {
  // Copy first: a listener may unsubscribe while being notified.
  for (const listener of Array.from(listeners)) {
    try {
      listener(type, data);
    } catch (error) {
      console.error(`WebSocket listener failed for "${type}":`, error);
    }
  }
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || listeners.size === 0) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
}

function open() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return socket;
  }

  cancelReconnect();
  cancelShutdown();
  setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

  let next;
  try {
    next = new WebSocket(WS_URL);
  } catch (error) {
    console.error('Could not open the WebSocket:', error);
    scheduleReconnect();
    return null;
  }
  socket = next;

  next.onopen = () => {
    if (socket !== next) return;
    attempt = 0;
    setStatus('online');
  };

  next.onmessage = event => {
    if (socket !== next) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      console.error('WebSocket message is not JSON:', error);
      return;
    }
    if (!payload || typeof payload.type !== 'string') return;
    dispatch(payload.type, payload.data);
  };

  next.onerror = () => {
    // The browser always follows an error with a close event; reconnecting is
    // handled there so a single failure never opens two sockets.
  };

  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    if (listeners.size === 0) {
      setStatus('idle');
      return;
    }
    setStatus('reconnecting');
    scheduleReconnect();
  };

  return next;
}

function closeNow() {
  cancelReconnect();
  cancelShutdown();
  const current = socket;
  socket = null;
  attempt = 0;

  if (!current) {
    setStatus('idle');
    return;
  }

  // Detach the handlers first: this close must not start a reconnect.
  current.onopen = null;
  current.onmessage = null;
  current.onerror = null;
  current.onclose = null;
  try {
    current.close(1000, 'client closed');
  } catch {
    // Already gone.
  }
  setStatus('idle');
}

function scheduleShutdown() {
  cancelShutdown();
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (listeners.size === 0) closeNow();
  }, SHUTDOWN_GRACE_MS);
}

/**
 * Listen to every server message. Returns the unsubscribe function.
 * The socket is opened on the first subscriber and closed after the last one.
 *
 * @param {(type: string, data: any) => void} listener
 * @returns {() => void}
 */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  cancelShutdown();
  open();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) scheduleShutdown();
  };
}

/** Connection status for a small indicator; returns the unsubscribe function. */
export function subscribeStatus(listener) {
  if (typeof listener !== 'function') return () => {};
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

export function getStatus() {
  return status;
}
