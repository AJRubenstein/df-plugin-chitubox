import assert from 'node:assert/strict';
import test from 'node:test';

import { CbxConverter } from '../CbxConverter';
import type { CbxModelInput, CbxTip } from '../converter/types';

const tip = (over: Partial<CbxTip>): CbxTip => ({
    x: 0, y: 0, contactZ: 3, attachZ: 1.4,
    socketX: 0, socketY: 0,
    length: 1.8, contactDiameter: 0.2, bodyDiameter: 0.8, contactDepth: 0,
    ...over,
});

/** A shaftless grounded support, its pillar offset in XY from the contact. */
const leaningModel = (pillarX: number): CbxModelInput => ({
    index: 0,
    filename: 'fixture',
    supports: [{
        pillarDiameter: 0.8,
        pillarTopZ: 0, pillarBottomZ: 0,
        pillarX, pillarY: 0,
        knotCenterZ: 0, knotDiameter: 0.9,
        base: null,
        tips: [tip({ x: 0, y: 0, contactZ: 3, attachZ: 0 })],
    }],
});

test('a stump stands under its own joint', () => {
    const data = CbxConverter.convert(leaningModel(0.8));
    const stump = data.stumps?.[0];
    assert.ok(stump, 'built as a stump');

    const dxy = Math.hypot(stump.joint.pos.x - stump.rootPos.x, stump.joint.pos.y - stump.rootPos.y);
    assert.ok(dxy < 1e-6, `root sits under the joint, off by ${dxy.toFixed(3)}mm`);
});

test('a support carrying a knot stays a trunk', () => {
    // A stump draws no shaft, so converting one whose segment carries a knot
    // would leave that knot naming an id no shaft owns.
    const model = leaningModel(0);
    model.supports[0].tips = [
        tip({ x: 0, y: 0, contactZ: 3, attachZ: 1.4 }),
        tip({ x: 0.6, y: 0.3, contactZ: 3.4, attachZ: 1.4 }),
    ];

    const data = CbxConverter.convert(model);
    assert.equal(data.stumps?.length ?? 0, 0, 'not converted');
    assert.equal(data.trunks?.length ?? 0, 1, 'kept as a trunk');

    const owned = new Set((data.trunks ?? []).flatMap((t) => t.segments.map((s) => s.id)));
    for (const knot of data.knots ?? []) {
        if (!knot.parentShaftId) continue;
        assert.ok(owned.has(knot.parentShaftId), 'every knot still rides a real segment');
    }
});
