import assert from 'node:assert/strict';
import test from 'node:test';

import { CbxConverter } from '../CbxConverter';
import type { CbxModelInput, CbxTip } from '../converter/types';

const tip = (over: Partial<CbxTip>): CbxTip => ({
    x: 0, y: 0, contactZ: 12, attachZ: 10,
    socketX: 0, socketY: 0,
    length: 2, contactDiameter: 0.3, bodyDiameter: 0.8, contactDepth: 0,
    ...over,
});

test('a brace binds to a stick shaft', () => {
    // shaftRefs drives brace attachment, so a stick has to be in it.
    const model: CbxModelInput = {
        index: 0,
        filename: 'fixture',
        supports: [
            // A stick: ungrounded, a contact at each end.
            {
                pillarDiameter: 0.8,
                pillarTopZ: 16, pillarBottomZ: 10,
                pillarX: 0, pillarY: 0,
                knotCenterZ: 16, knotDiameter: 0.9,
                base: null,
                tips: [tip({ x: 0.4, y: 0.2, contactZ: 18, attachZ: 16 })],
                downwardTip: tip({ contactZ: 8, attachZ: 10, x: 0.5, y: 0 }),
            },
            // A grounded trunk well away in XY, the only other brace host.
            {
                pillarDiameter: 0.8,
                pillarTopZ: 16, pillarBottomZ: 0,
                pillarX: 6, pillarY: 0,
                knotCenterZ: 16, knotDiameter: 0.9,
                base: null,
                tips: [tip({ x: 6, y: 0, contactZ: 18, attachZ: 16 })],
            },
        ],
        // Spans the stick to the trunk at mid-height.
        braces: [{ ax: 0, ay: 0, az: 13, bx: 6, by: 0, bz: 13, diameter: 0.3 }],
    };

    const data = CbxConverter.convert(model);
    assert.equal(data.sticks?.length ?? 0, 1, 'the stick was built');
    assert.equal(data.braces?.length ?? 0, 1, 'the brace attached rather than being dropped');
});
