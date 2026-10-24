import assert from 'node:assert/strict';
import test from 'node:test';

import { CbxConverter } from '../CbxConverter';
import type { CbxModelInput, CbxTip } from '../converter/types';

const tip = (over: Partial<CbxTip>): CbxTip => ({
    x: 0, y: 0, contactZ: 12, attachZ: 10,
    socketX: 0, socketY: 0,
    length: 2, contactDiameter: 0.3, bodyDiameter: 0.3, contactDepth: 0,
    ...over,
});

/** An ungrounded shaft with a contact at each end, at the given thickness. */
const spanModel = (pillarDiameter: number): CbxModelInput => ({
    index: 0,
    filename: 'fixture',
    supports: [{
        pillarDiameter,
        pillarTopZ: 10, pillarBottomZ: 8,
        pillarX: 0, pillarY: 0,
        knotCenterZ: 10, knotDiameter: pillarDiameter + 0.1,
        base: null,
        tips: [tip({ x: 0.4, y: 0.2 })],
        downwardTip: tip({ contactZ: 6, attachZ: 8, x: 0.5, y: 0 }),
    }],
});

test('a thin two-contact support builds as a twig', () => {
    // A stick sizes its joints off the shaft, leaving them proud at this width.
    const data = CbxConverter.convert(spanModel(0.3));
    assert.equal(data.sticks?.length ?? 0, 0, 'not a stick');
    assert.equal(data.twigs?.length ?? 0, 1, 'built as a twig');

    const seg = data.twigs![0].segments[0];
    const ratio = (seg.bottomJoint?.diameter ?? 0) / (seg.diameter || 1);
    assert.ok(ratio < 1.2, `joint sits close to the body, got ${ratio.toFixed(2)}x`);
});

test('a thick two-contact support stays a stick', () => {
    const data = CbxConverter.convert(spanModel(1.2));
    assert.equal(data.twigs?.length ?? 0, 0, 'not a twig');
    assert.equal(data.sticks?.length ?? 0, 1, 'still a stick');
});
