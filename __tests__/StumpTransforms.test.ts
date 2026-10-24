import assert from 'node:assert/strict';
import test from 'node:test';

import { CbxConverter } from '../CbxConverter';
import type { DragonfruitImportFormat, Stump } from '@/supports/types';

const stumpData = (): DragonfruitImportFormat => ({
    version: 1,
    meta: { source: 'fixture', objectCenter: { x: 0, y: 0, z: 0 }, updatedAt: 0 },
    roots: [],
    trunks: [],
    branches: [],
    leaves: [],
    twigs: [],
    sticks: [],
    braces: [],
    knots: [],
    kickstands: [],
    stumps: [{
        id: 'stump-1',
        modelId: 'model-1',
        rootPos: { x: 1, y: 2, z: 0 },
        rootBaseDiameter: 3,
        rootTopDiameter: 0.8,
        rootHeight: 2,
        joint: { id: 'j1', pos: { x: 1, y: 2, z: 1.5 }, diameter: 0.9 },
        segments: [],
        contactCone: {
            id: 'c1',
            pos: { x: 1, y: 2, z: 3 },
            normal: { x: 0, y: 0, z: -1 },
            surfaceNormal: { x: 0, y: 0, z: -1 },
            socketJointId: 'j1',
            profile: {
                type: 'disk', lengthMm: 1.5, contactDiameterMm: 0.2,
                bodyDiameterMm: 0.8, diskThicknessMm: 0.1,
                maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4, penetrationMm: 0.1,
            },
        },
    } as unknown as Stump],
});

test('a stump moves with the cluster in Z', () => {
    const data = stumpData();
    CbxConverter.applyZShift(data, 10);
    const stump = data.stumps![0];
    assert.equal(stump.rootPos.z, 10, 'its inline root moved');
    assert.equal(stump.joint.pos.z, 11.5, 'its joint moved');
    assert.equal(stump.contactCone.pos.z, 13, 'its contact moved');
});

test('a stump moves with the cluster in XY', () => {
    const data = stumpData();
    CbxConverter.applyXYShift(data, 5, -3);
    const stump = data.stumps![0];
    assert.deepEqual(
        { x: stump.rootPos.x, y: stump.rootPos.y }, { x: 6, y: -1 }, 'its inline root moved',
    );
    assert.deepEqual(
        { x: stump.joint.pos.x, y: stump.joint.pos.y }, { x: 6, y: -1 }, 'its joint moved',
    );
    assert.deepEqual(
        { x: stump.contactCone.pos.x, y: stump.contactCone.pos.y }, { x: 6, y: -1 },
        'its contact moved',
    );
});

test('a stump is seated on the plate', () => {
    const data = stumpData();
    data.stumps![0].rootPos.z = -16.3;
    CbxConverter.seatRootsOnPlate(data, 0);
    assert.equal(data.stumps![0].rootPos.z, 0, 'its inline root sits on the plate');
});
