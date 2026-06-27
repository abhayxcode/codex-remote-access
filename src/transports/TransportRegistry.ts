import type { Transport } from "./Transport.js";

export class TransportRegistry {
  private readonly transports = new Map<string, Transport>();

  register(transport: Transport) {
    this.transports.set(transport.id, transport);
  }

  get(id: string) {
    return this.transports.get(id) || null;
  }

  list() {
    return Array.from(this.transports.values());
  }
}
