// Main-thread heartbeat plus a worker that SIGKILLs the child if the loop stalls while a reverse request is open.
import { Worker } from 'node:worker_threads';

/** How often the main thread proves the event loop is still running. */
export const WATCHDOG_HEARTBEAT_MS = 250;

const slots = { heartbeat: 0, pending: 1, pid: 2, fired: 3, stall: 4, stop: 5 } as const;

export class EventLoopWatchdog {
  private readonly view = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly worker: Worker;

  constructor(stallMs: number) {
    const beat = () => {
      Atomics.add(this.view, slots.heartbeat, 1);
      Atomics.notify(this.view, slots.heartbeat);
    };
    beat();
    this.timer = setInterval(beat, WATCHDOG_HEARTBEAT_MS);
    this.timer.unref();
    this.worker = new Worker(new URL('./watchdog-worker.js', import.meta.url), {
      workerData: { sab: this.view.buffer, stallMs, beatMs: WATCHDOG_HEARTBEAT_MS, slots },
    });
    // A watchdog must not keep Pi alive after the session is gone.
    this.worker.unref();
  }

  setPid(pid: number) {
    Atomics.store(this.view, slots.pid, pid > 0 ? pid : 0);
  }

  /** A hook, permission, or question has arrived and has not been answered. */
  enter() { Atomics.add(this.view, slots.pending, 1); }

  leave() {
    for (;;) {
      const cur = Atomics.load(this.view, slots.pending);
      if (cur <= 0) return;
      if (Atomics.compareExchange(this.view, slots.pending, cur, cur - 1) === cur) return;
    }
  }

  /** One-shot read of a kill this worker already performed. */
  takeKill(): { stallMs: number } | undefined {
    if (Atomics.compareExchange(this.view, slots.fired, 1, 0) !== 1) return undefined;
    return { stallMs: Atomics.load(this.view, slots.stall) };
  }

  /** session_shutdown and connection.close() both end here. */
  stop() {
    clearInterval(this.timer);
    Atomics.store(this.view, slots.pid, 0);
    Atomics.store(this.view, slots.stop, 1);
    Atomics.notify(this.view, slots.heartbeat);
    void this.worker.terminate();
  }
}
