import assert from 'tjs:assert';
import { EventEmitter } from 'node:events';
import type { DockDriver, DeviceImageSpec } from '../src/devices/driver.js';
import { findModel } from '../src/devices/registry.js';
import { wireCommonDriverEvents } from '../src/main/dock-status.js';
import { StreonorExtraKeysDriver, wireStreonorExtraKeys } from '../src/main/streonor-extra-keys.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { CoraDock } from '../src/main/cora-dock.js';
import type { DriverManager } from '../src/main/driver-manager.js';
import type { Dock } from '../src/main/dock.js';
import type { ElgatoServer } from '../src/cora/primary-server.js';
import type { ElgatoChildServer } from '../src/cora/child-server.js';
import {
  blitImage,
  canvasSliceToBmp,
  transformImageForDevice,
} from '../src/transform/translator.js';
import { test, testAsync, summary } from './helpers/harness.js';

function hardware() {
  const writes: { wire: number; bytes: Uint8Array; spec: DeviceImageSpec }[] = [];
  const clears: number[] = [];
  const driver = Object.assign(new EventEmitter(), {
    model: findModel(0x1500, 0x3007)!,
    sendSplashImage: (wire: number, bytes: Uint8Array, spec: DeviceImageSpec) =>
      writes.push({ wire, bytes, spec }),
    clearKey: (wire: number) => clears.push(wire),
  }) as unknown as DockDriver;
  return { driver, writes, clears };
}

test('all ten keys have exactly one Elgato owner; dials and touch stay on Plus', () => {
  const h = hardware();
  const plus: number[] = [];
  const mini: number[] = [];
  let widgets = 0;
  let dials = 0;
  let touches = 0;
  wireCommonDriverEvents(h.driver, h.driver.model, {
    onKey: (key) => plus.push(key),
    onExtraKey: () => widgets++,
    onDial: () => dials++,
    onTouch: () => touches++,
    onReinit: () => {},
  });
  const proxy = new StreonorExtraKeysDriver();
  proxy.setHardware(h.driver);
  proxy.on('key', ({ keyIndex }) => mini.push(keyIndex));
  for (let keyIndex = 1; keyIndex <= 10; keyIndex++)
    h.driver.emit('key', { keyIndex, state: 'down' });
  h.driver.emit('dial', { index: 0, kind: 'rotate', delta: 1 });
  h.driver.emit('touch', { type: 'tap', x: 100, y: 50 });
  assert.deepEqual(plus, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(mini, [0, 3]);
  assert.equal(widgets, 0, 'the widget scheduler must not own the same two displays');
  assert.equal(dials, 1);
  assert.equal(touches, 1);
  void proxy.close();
});

test('only the two Mini slots write to the two right-column displays', () => {
  const h = hardware();
  const proxy = new StreonorExtraKeysDriver();
  proxy.setHardware(h.driver);
  const image = new Uint8Array([66, 77, 1, 2]);
  for (let key = 0; key < 6; key++) proxy.renderCoraImage(key, image, 'bmp');
  assert.deepEqual(
    h.writes.map((w) => w.wire),
    [15, 10],
  );
  assert.equal(h.writes[0]!.bytes, image);
  assert.equal(
    h.writes[0]!.spec.rotate,
    270,
    'undo Mini pre-rotation before the Streonor transform',
  );
  assert.equal(h.writes[0]!.spec.width, 112);
  assert.equal(h.writes[0]!.spec.flipH, true);
  assert.equal(h.driver.model.image.rotate, 180, 'the Plus image transform stays unchanged');
  proxy.clearKey(1);
  proxy.clearKey(3);
  assert.deepEqual(h.clears, [10]);
  void proxy.close();
});

test('Mini transposition becomes upright, unmirrored pixels on the physical LCD', () => {
  const h = hardware();
  const proxy = new StreonorExtraKeysDriver();
  proxy.setHardware(h.driver);
  const red = [240, 0, 0],
    green = [0, 240, 0],
    blue = [0, 0, 240],
    white = [240, 240, 240];
  // Mini's raw top-right and bottom-left quadrants swap relative to the editor.
  const miniColors = [red, blue, green, white];
  const pixels = new Uint8Array(80 * 80 * 3);
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 80; x++) {
      pixels.set(miniColors[(y < 40 ? 0 : 2) + (x < 40 ? 0 : 1)]!, (y * 80 + x) * 3);
    }
  }
  proxy.renderCoraImage(0, canvasSliceToBmp(pixels, 80, 80, 0, 80), 'bmp');
  const write = h.writes[0]!;
  const wireImage = transformImageForDevice(write.bytes, write.spec);
  const decoded = new Uint8Array(112 * 112 * 3);
  blitImage(decoded, 112, 112, wireImage, 0, 0);
  for (const [x, y, expected] of [
    [28, 28, red],
    [84, 28, green],
    [28, 84, blue],
    [84, 84, white],
  ] as const) {
    // The physical LCD is mounted 180 degrees from the uploaded JPEG.
    const offset = ((111 - y) * 112 + (111 - x)) * 3;
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(
        Math.abs(decoded[offset + channel]! - expected[channel]!) < 8,
        `LCD quadrant ${x},${y}`,
      );
    }
  }
  void proxy.close();
});

test('USB replug replays art and moves input ownership without closing the USB worker', () => {
  const old = hardware();
  const next = hardware();
  const proxy = new StreonorExtraKeysDriver();
  const input: number[] = [];
  proxy.on('key', ({ keyIndex }) => input.push(keyIndex));
  proxy.setHardware(old.driver);
  proxy.renderCoraImage(0, new Uint8Array([1]), 'bmp');
  proxy.setHardware(null);
  old.driver.emit('key', { keyIndex: 5, state: 'down' });
  proxy.renderCoraImage(3, new Uint8Array([2]), 'bmp');
  proxy.setHardware(next.driver);
  next.driver.emit('key', { keyIndex: 10, state: 'up' });
  assert.deepEqual(input, [3]);
  assert.deepEqual(
    next.writes.map((w) => w.wire),
    [15, 10],
  );
  void proxy.close();
  assert.equal(next.driver.listenerCount('key'), 0);
});

test('unplug releases held keys and forwards USB overload to the extra CORA panel', () => {
  const h = hardware();
  const proxy = new StreonorExtraKeysDriver();
  const states: string[] = [];
  let overloads = 0;
  proxy.on('key', ({ state }) => states.push(state));
  proxy.on('overload', () => overloads++);
  proxy.setHardware(h.driver);
  h.driver.emit('key', { keyIndex: 5, state: 'down' });
  h.driver.emit('overload');
  proxy.setHardware(null);
  h.driver.emit('overload');
  assert.deepEqual(states, ['down', 'up']);
  assert.equal(overloads, 1);
  void proxy.close();
});

await testAsync(
  'panel survives a USB replug and shuts down without taking ownership of USB',
  async () => {
    class FakeServer extends EventEmitter {
      hasClient = false;
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      setDeviceConfig(): void {}
      setChildGeometry(): void {}
      restartMdns(): void {}
      pushChildCapabilities(): void {}
      setMdnsServiceName(): void {}
      sendKeyEvent(): void {}
    }
    const settings = new PersistedSettings(`${tjs.tmpDir}/streonor-extras-test-${tjs.pid}`);
    await settings.load();
    const registered = new Map<number, Dock>();
    const children: FakeServer[] = [];
    const previews: number[] = [];
    const presses: number[][] = [];
    const connected: Array<{ index: number; deviceKey: string }> = [];
    const first = hardware();
    const second = hardware();
    let current: DockDriver | null = first.driver;
    const host = Object.assign(new EventEmitter(), {
      getCurrentDriver: () => current,
      dock: (index: number) =>
        index === 0
          ? { status: () => ({ deviceKey: 'usb:streonor-test' }) }
          : registered.get(index),
      hooksForDock: () => ({}),
      addExternalDock: (dock: Dock) => registered.set(dock.index, dock),
      removeExternalDock: (index: number) => registered.delete(index),
      simulateKeyPress: (dock: number, index: number) => {
        presses.push([dock, index]);
        return true;
      },
    }) as unknown as DriverManager;
    const wiring = wireStreonorExtraKeys({
      driverManager: host,
      settings,
      getShuttingDown: () => false,
      onPreviewImage: (index) => previews.push(index),
      onDockConnected: (index, deviceKey) => connected.push({ index, deviceKey }),
      coraDockFactory: (_slot, bindAddress) => {
        assert.equal(bindAddress, '127.0.0.2', 'Elgato needs a distinct IP for the second dock');
        const child = new FakeServer();
        children.push(child);
        return new CoraDock(
          new FakeServer() as unknown as ElgatoServer,
          child as unknown as ElgatoChildServer,
          'extra test',
        );
      },
    });
    try {
      await wiring.sync();
      assert.equal(registered.size, 1);
      assert.equal(registered.get(2)!.status().primaryPort, 5347);
      assert.equal(registered.get(2)!.status().pairingAddress, '127.0.0.2');
      assert.deepEqual(
        connected,
        [{ index: 2, deviceKey: 'usb:streonor-test:extra-keys' }],
        'automatic reconnect must also watch the Mini panel',
      );
      children[0]!.emit('image', { keyIndex: 0, data: new Uint8Array([66, 77]), format: 'bmp' });
      assert.equal(first.writes[0]!.wire, 15);
      children[0]!.emit('image', { keyIndex: 3, data: new Uint8Array([66, 77]), format: 'bmp' });
      assert.deepEqual(previews, [8, 9], 'mirror both Mini images into the physical preview');
      assert.equal(wiring.pressPreviewKey(8), true);
      assert.equal(wiring.pressPreviewKey(9), true);
      assert.equal(wiring.pressPreviewKey(7), false, 'ordinary Plus slots keep their owner');
      assert.deepEqual(presses, [
        [2, 0],
        [2, 3],
      ]);
      current = null;
      await wiring.sync();
      current = second.driver;
      await wiring.sync();
      assert.equal(
        children.length,
        1,
        'keep the same CORA listeners and pairing across a USB replug',
      );
      assert.equal(second.writes[0]!.wire, 15, 'restore the last Elgato frame after replug');
      assert.deepEqual(previews, [8, 9, 8, 9], 'restore the merged preview after a USB replug');
      assert.equal(connected.length, 1, 'a USB replug keeps the same Mini CORA session');
    } finally {
      await wiring.stop();
      await settings.close();
    }
    assert.equal(registered.size, 0);
    assert.equal(second.driver.listenerCount('key'), 0);
  },
);

summary();
