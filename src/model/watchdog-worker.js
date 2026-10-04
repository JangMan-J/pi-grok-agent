// Event-loop watchdog. Runs off the main thread so a frozen Pi loop cannot silence it.
// Slots arrive in workerData.slots and must match EventLoopWatchdog in watchdog.ts.
import { workerData } from 'node:worker_threads';

const { sab, stallMs, beatMs, slots } = workerData;
const view = new Int32Array(sab);
let last = Atomics.load(view, slots.heartbeat);
let lastChange = Date.now();

while (Atomics.load(view, slots.stop) === 0) {
  Atomics.wait(view, slots.heartbeat, last, beatMs);
  if (Atomics.load(view, slots.stop) !== 0) break;
  const nowCount = Atomics.load(view, slots.heartbeat);
  const now = Date.now();
  if (nowCount !== last) {
    last = nowCount;
    lastChange = now;
    continue;
  }
  const stalled = now - lastChange;
  if (stalled < stallMs) continue;
  const pending = Atomics.load(view, slots.pending);
  const pid = Atomics.load(view, slots.pid);
  // pid 0 is "no child". process.kill(0) would signal the whole process group.
  if (pending > 0 && pid > 0 && Atomics.compareExchange(view, slots.fired, 0, 1) === 0) {
    Atomics.store(view, slots.stall, stalled);
    Atomics.store(view, slots.pid, 0);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
