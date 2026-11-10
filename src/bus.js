import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {
  change(type, id = null, extra = {}) {
    this.emit('change', { type, id, ...extra, at: Date.now() });
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
