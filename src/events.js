import { performanceNow } from "./utils.js";

export class SimpleEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  dispatchEvent(event) {
    if (!event || !event.type) {
      throw new TypeError("Event object requires a type.");
    }
    if (event.timeStamp == null) {
      event.timeStamp = performanceNow();
    }
    event.target = this;
    event.currentTarget = this;
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        if (typeof listener === "function") {
          listener.call(this, event);
        } else if (listener && typeof listener.handleEvent === "function") {
          listener.handleEvent(event);
        }
      }
    }
    const handler = this[`on${event.type}`];
    if (typeof handler === "function") {
      handler.call(this, event);
    }
    return true;
  }
}

export function createMIDIConnectionEvent(port) {
  return {
    type: "statechange",
    port,
    timeStamp: performanceNow()
  };
}
