import assert from 'node:assert/strict';
import test from 'node:test';

import { CbxConverter } from '../CbxConverter';
import { CBX_ROOT_DEFAULTS } from '../converter/types';
import type { CbxModelInput, CbxTip } from '../converter/types';

const FULL_ROOT_MM = CBX_ROOT_DEFAULTS.diskHeightMm + CBX_ROOT_DEFAULTS.coneHeightMm;

const tip = (over: Partial<CbxTip> = {}): CbxTip => ({
    x: 0, y: 0, contactZ: 12, attachZ: 10,
    socketX: 0, socketY: 0,
    length: 2, contactDiameter: 0.2, bodyDiameter: 1, contactDepth: 0,
    ...over,
});

/**
 * A grounded trunk with no authored base pad, so it takes a settings root. The
 * contact is held well above the stump threshold so the support stays a trunk
 * however short its shaft is.
 */
const trunkOnShaft = (shaftTopZ: number): CbxModelInput => ({
    index: 0,
    filename: 'fixture',
    supports: [{
        pillarDiameter: 1,
        pillarTopZ: shaftTopZ, pillarBottomZ: 0,
        pillarX: 0, pillarY: 0,
        knotCenterZ: shaftTopZ / 2, knotDiameter: 1.1,
        base: null,
        tips: [tip({ contactZ: 12, attachZ: shaftTopZ })],
    }],
});

const rootHeight = (shaftTopZ: number): number => {
    const out = CbxConverter.convert(trunkOnShaft(shaftTopZ));
    assert.equal(out.stumps?.length ?? 0, 0, 'stayed a trunk');
    const root = out.roots?.[0];
    assert.ok(root, 'a root was built');
    return (root.diskHeight ?? 0) + (root.coneHeight ?? 0);
};

test('a trunk roots no deeper than half its shaft', () => {
    // The settings root is sized for a full-height support; left alone it
    // stands taller than a short shaft and surfaces through the model. 3mm is
    // the first shaft that can seat the whole root at half its rise.
    for (const shaft of [0.4, 1.0, 2.0, 2.9]) {
        const h = rootHeight(shaft);
        assert.ok(h <= shaft / 2 + 1e-6, `shaft ${shaft}mm got a ${h.toFixed(3)}mm root`);
        assert.ok(h >= 0, `root height stays positive, got ${h}`);
    }

    for (const shaft of [3.0, 10]) {
        assert.ok(
            Math.abs(rootHeight(shaft) - FULL_ROOT_MM) < 1e-6,
            `a ${shaft}mm shaft keeps the full root`,
        );
    }
});

test('a clamped root spends its budget on the disk before the cone', () => {
    // Below 1mm of budget there is no cone left; the disk is what keeps the
    // shaft seated on the plate.
    const out = CbxConverter.convert(trunkOnShaft(0.6));
    const root = out.roots?.[0];
    assert.ok(root, 'a root was built');
    assert.equal(root.coneHeight, 0, 'no cone at this budget');
    assert.ok((root.diskHeight ?? 0) > 0, 'but still a disk');
});
