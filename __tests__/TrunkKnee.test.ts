import assert from 'node:assert/strict';
import test from 'node:test';

import { CbxConverter } from '../CbxConverter';
import type { CbxModelInput, CbxTip } from '../converter/types';

const tip = (over: Partial<CbxTip>): CbxTip => ({
    x: 0, y: 0, contactZ: 12, attachZ: 10,
    socketX: 0, socketY: 0,
    length: 2, contactDiameter: 0.2, bodyDiameter: 1, contactDepth: 0,
    ...over,
});

/** A tall grounded trunk whose authored knot sits at `knotCenterZ`. */
const trunkModel = (knotCenterZ: number): CbxModelInput => ({
    index: 0,
    filename: 'fixture',
    supports: [{
        pillarDiameter: 1,
        pillarTopZ: 10, pillarBottomZ: 0,
        pillarX: 0, pillarY: 0,
        knotCenterZ, knotDiameter: 1.1,
        base: null,
        tips: [tip({ contactZ: 12, attachZ: 10 })],
    }],
});

const segmentLengths = (segments: { bottomJoint?: { pos: { x: number; y: number; z: number } }; topJoint?: { pos: { x: number; y: number; z: number } } }[]) =>
    segments
        .filter((s) => s.bottomJoint && s.topJoint)
        .map((s) => Math.hypot(
            s.topJoint!.pos.x - s.bottomJoint!.pos.x,
            s.topJoint!.pos.y - s.bottomJoint!.pos.y,
            s.topJoint!.pos.z - s.bottomJoint!.pos.z,
        ));

test('a knot above the cone socket leaves the shaft whole', () => {
    // The knee only exists to seat a knot partway up. Asked for one at or above
    // the socket, splitting buys nothing and leaves a stub below the cone.
    const trunk = CbxConverter.convert(trunkModel(20)).trunks?.[0];
    assert.ok(trunk, 'a trunk was built');
    assert.equal(trunk.segments.length, 1, 'one segment, no knee');
});

test('a knot partway up still gets its knee', () => {
    const trunk = CbxConverter.convert(trunkModel(5)).trunks?.[0];
    assert.ok(trunk, 'a trunk was built');
    assert.equal(trunk.segments.length, 2, 'split at the knee');

    for (const len of segmentLengths(trunk.segments)) {
        assert.ok(len > 1, `each jointed segment is a real body, got ${len.toFixed(3)}mm`);
    }
});
