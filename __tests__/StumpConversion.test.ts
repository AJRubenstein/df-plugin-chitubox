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

test('contact height alone decides a stump', () => {
    // A real shaft is no reason to stay a trunk: the renderer cannot draw a
    // trunk this short.
    for (const [contactZ, shaftTopZ] of [[3, 0], [3, 1.4], [4.9, 2]]) {
        const data = CbxConverter.convert(groundedModel(contactZ, shaftTopZ));
        assert.equal(data.stumps?.length ?? 0, 1, `${contactZ}mm contact is a stump`);
        assert.equal(data.trunks?.length ?? 0, 0, 'not left as a trunk');
    }

    const tall = CbxConverter.convert(groundedModel(20, 18));
    assert.equal(tall.stumps?.length ?? 0, 0, 'a tall support stays a trunk');
});

test('a stump root runs from the plate to just under its joint', () => {
    // Nothing is drawn between root and joint, so a short root leaves the joint
    // floating and a tall one swallows it.
    for (const [contactZ, shaftTopZ] of [[3, 1.4], [4, 2], [2.1, 0.08]]) {
        const stump = CbxConverter.convert(groundedModel(contactZ, shaftTopZ)).stumps?.[0];
        assert.ok(stump, `built as a stump at ${contactZ}mm`);

        assert.ok(stump.rootPos.z <= 1e-6, `starts on the plate, got ${stump.rootPos.z}`);
        assert.ok(stump.rootHeight >= 0.3, `has a body, got ${stump.rootHeight.toFixed(3)}mm`);

        const gap = stump.joint.pos.z - (stump.rootPos.z + stump.rootHeight);
        assert.ok(gap > 0 && gap <= 0.2, `joint sits on its root, gap ${gap.toFixed(3)}mm`);
    }
});

test('a stump stands on the plate, not on its own trunk root', () => {
    // A support's own root can start above the plate, on a foot cluster or a
    // pad; seating the stump there leaves it floating.
    const data = CbxConverter.convert({
        index: 0,
        filename: 'fixture',
        supports: [
            // A tall neighbour establishes where the plate actually is.
            {
                pillarDiameter: 0.8,
                pillarTopZ: 9, pillarBottomZ: 0,
                pillarX: 20, pillarY: 0,
                knotCenterZ: 9, knotDiameter: 0.9,
                base: null,
                tips: [tip({ x: 20, y: 0, contactZ: 11, attachZ: 9 })],
            },
            // This one starts 1mm up, as a support on a foot cluster does.
            {
                pillarDiameter: 0.8,
                pillarTopZ: 1.4, pillarBottomZ: 1,
                pillarX: 0, pillarY: 0,
                knotCenterZ: 1.4, knotDiameter: 0.9,
                base: null,
                tips: [tip({ x: 0, y: 0, contactZ: 3, attachZ: 1.4 })],
            },
        ],
    });

    const stump = data.stumps?.find((s) => Math.abs(s.rootPos.x) < 1e-6);
    assert.ok(stump, 'the short support became a stump');
    assert.ok(stump.rootPos.z <= 1e-6, `on the plate, got z=${stump.rootPos.z.toFixed(3)}`);
    assert.ok(stump.rootPos.z + stump.rootHeight > 1.0, 'and reaches past its trunk root');
});

test('the cone stretches to meet a joint seated on the root', () => {
    // The cone sockets onto the joint, so raising the joint without lengthening
    // the cone would leave the contact detached.
    const stump = CbxConverter.convert(groundedModel(2.1, 0.08)).stumps?.[0];
    assert.ok(stump, 'built as a stump');

    const cone = stump.contactCone;
    const socketZ = cone.pos.z + cone.normal.z * (cone.profile?.lengthMm ?? 0);
    assert.ok(
        Math.abs(socketZ - stump.joint.pos.z) < 1e-6,
        `cone reaches its joint, off by ${(socketZ - stump.joint.pos.z).toFixed(4)}mm`,
    );
});
