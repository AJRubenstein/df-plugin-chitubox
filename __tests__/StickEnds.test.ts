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

/**
 * An ungrounded shaft with a contact hanging below it: a stick. Thick enough
 * to stay one -- a thin span builds as a twig instead.
 */
const stickModel = (tips: CbxTip[]): CbxModelInput => ({
    index: 0,
    filename: 'fixture',
    supports: [{
        pillarDiameter: 1.2,
        pillarTopZ: 10, pillarBottomZ: 8,
        pillarX: 0, pillarY: 0,
        knotCenterZ: 10, knotDiameter: 1.3,
        base: null,
        tips,
        downwardTip: tip({ contactZ: 6, attachZ: 8, x: 0.5, y: 0 }),
    }],
});

test('a stick takes its far end from the first upward contact', () => {
    const data = CbxConverter.convert(stickModel([tip({ x: 0.4, y: 0.2 })]));
    const [stick] = data.sticks ?? [];
    assert.ok(stick, 'a stick was built');
    // A capped cone B is ~zero length; a real end carries the authored cone.
    assert.ok(
        (stick.contactConeB?.profile?.lengthMm ?? 0) > 0.01,
        'cone B is a real contact, not a cap',
    );
    assert.equal(data.leaves?.length ?? 0, 0, 'the only tip became the end, not a leaf');
});

test('further contacts fan off the hub as leaves', () => {
    const data = CbxConverter.convert(stickModel([
        tip({ x: 0.4, y: 0.2 }),
        tip({ x: -0.4, y: 0.2, contactZ: 11.5 }),
        tip({ x: 0, y: -0.5, contactZ: 11.2 }),
    ]));
    const [stick] = data.sticks ?? [];
    assert.ok((stick?.contactConeB?.profile?.lengthMm ?? 0) > 0.01, 'cone B is the first end');
    assert.equal(data.leaves?.length ?? 0, 2, 'the other two fan as leaves');
});
