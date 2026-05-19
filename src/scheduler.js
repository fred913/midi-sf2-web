import { DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS } from "./constants.js";
import { positiveNumberOrDefault } from "./utils.js";

export class LookaheadScheduler {
  constructor(options) {
    this.intervalMs = positiveNumberOrDefault(options.intervalMs, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS);
    this.onTick = options.onTick;
    this.timer = null;
  }

  start() {
    if (this.timer != null) {
      return;
    }
    this.timer = globalThis.setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer == null) {
      return;
    }
    globalThis.clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    this.onTick();
  }
}
