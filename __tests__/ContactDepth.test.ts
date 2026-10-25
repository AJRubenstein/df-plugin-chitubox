import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { surfaceContact } from '../converter/geometryHelpers';
import type { CbxTip } from '../converter/types';

const tip = (over: Partial<CbxTip>): CbxTip => ({
    x: 0, y: 0, contactZ: 10, attachZ: 8,
    socketX: 0, socketY: 0,
    length: 2, contactDiameter: 0.2, bodyDiameter: 1, contactDepth: 0,
    ...over,
});

const world = (t: CbxTip) => new THREE.Vector3(t.x, t.y, t.contactZ);

test('a penetrating contact is backed out along the cone axis', () => {
    // The axis is (3, 0, 4)/5, so 0.5mm back along it is exactly (0.3, 0, 0.4):
    // pulling it straight up in Z instead would lose the authored direction.
    const t = tip({ contactDepth: 0.5, socketX: 3, attachZ: 14 });
    const out = surfaceContact(t, world(t));

    assert.ok(Math.abs(out.x - 0.3) < 1e-6, `moved in X, got ${out.x}`);
    assert.ok(Math.abs(out.z - 10.4) < 1e-6, `moved in Z, got ${out.z}`);
});

test('a contact on the surface or with no axis is left alone', () => {
    const onSurface = tip({ contactDepth: 0 });
    assert.deepEqual(toTuple(surfaceContact(onSurface, world(onSurface))), [0, 0, 10]);

    // socket == contact: no direction to retract along.
    const degenerate = tip({ contactDepth: 0.3, attachZ: 10 });
    assert.deepEqual(toTuple(surfaceContact(degenerate, world(degenerate))), [0, 0, 10]);
});

function toTuple(v: THREE.Vector3) {
    return [v.x, v.y, v.z];
}
