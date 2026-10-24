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

/** A grounded support whose contact sits `contactZ` above the plate. */
const groundedModel = (contactZ: number, pillarTopZ: number): CbxModelInput => ({
    index: 0,
    filename: 'fixture',
    supports: [{
        pillarDiameter: 0.8,
        pillarTopZ, pillarBottomZ: 0,
        pillarX: 0, pillarY: 0,
        knotCenterZ: pillarTopZ, knotDiameter: 0.9,
        base: null,
        tips: [tip({ contactZ, attachZ: pillarTopZ })],
    }],
});

test('a short support with no shaft becomes a stump', () => {
    // The joint ends up inside the root cone, so there is no shaft to draw.
    const data = CbxConverter.convert(groundedModel(3, 1.4));
    assert.equal(data.stumps?.length ?? 0, 1, 'built as a stump');
    assert.equal(data.trunks?.length ?? 0, 0, 'not left as a trunk');

    const stump = data.stumps![0];
    assert.equal(stump.segments.length, 0, 'a stump draws no shaft');
    assert.ok(stump.contactCone, 'it keeps its contact');
    assert.ok(stump.rootHeight > 0, 'the root is carried inline');
    assert.equal(data.roots?.length ?? 0, 0, 'its separate root entity is gone');
});

test('a tall support stays a trunk', () => {
    const data = CbxConverter.convert(groundedModel(20, 18));
    assert.equal(data.stumps?.length ?? 0, 0, 'not a stump');
    assert.equal(data.trunks?.length ?? 0, 1, 'still a trunk');
    assert.equal(data.roots?.length ?? 0, 1, 'and keeps its root');
});
