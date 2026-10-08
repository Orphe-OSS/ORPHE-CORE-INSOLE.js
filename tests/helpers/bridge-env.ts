/** タブ間共有（BleSharedBridge）のテスト用環境 */
import type { BridgeChannel, BridgeEnvironment } from '../../src/bridge.ts';
import { MemoryStorage } from './mock-bluetooth.ts';

/** 同一オリジンの複数タブを模した環境。storage とチャネルを共有する */
export class MockTabWorld {
  readonly storage = new MemoryStorage();
  private readonly channels = new Map<string, Set<FakeChannel>>();
  private readonly windowListeners = new Map<string, Set<(event: unknown) => void>>();

  createEnvironment(): BridgeEnvironment {
    const world = this;
    return {
      storage: this.storage,
      createChannel(name) { return new FakeChannel(world, name); },
      addWindowListener(type, listener) {
        if (!world.windowListeners.has(type)) world.windowListeners.set(type, new Set());
        world.windowListeners.get(type)!.add(listener);
      },
      removeWindowListener(type, listener) { world.windowListeners.get(type)?.delete(listener); },
    };
  }

  channelBus(name: string): Set<FakeChannel> {
    if (!this.channels.has(name)) this.channels.set(name, new Set());
    return this.channels.get(name)!;
  }
}

export class FakeChannel implements BridgeChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  private readonly world: MockTabWorld;
  private readonly name: string;
  constructor(world: MockTabWorld, name: string) {
    this.world = world;
    this.name = name;
    world.channelBus(name).add(this);
  }
  postMessage(message: unknown): void {
    if (this.closed) return;
    for (const peer of this.world.channelBus(this.name)) {
      if (peer !== this && !peer.closed) peer.onmessage?.({ data: message });
    }
  }
  close(): void {
    this.closed = true;
    this.world.channelBus(this.name).delete(this);
  }
}

