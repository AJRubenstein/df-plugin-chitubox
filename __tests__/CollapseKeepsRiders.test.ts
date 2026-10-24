import assert from 'node:assert/strict';
import test from 'node:test';

import { collapseDegenerateJoints } from '../converter/sanityPasses';

const joint = (id: string, z: number) => ({ id, pos: { x: 0, y: 0, z }, diameter: 0.4 });
const segment = (id: string, bot: string, botZ: number, top: string, topZ: number) => ({
    id,
    type: 'straight' as const,
    diameter: 0.3,
    bottomJoint: joint(bot, botZ),
    topJoint: joint(top, topZ),
});

test('a stub between two segments collapses, carrying its riders', () => {
    const trunk = {
        id: 'trunk-1',
        segments: [
            segment('seg-low', 'j0', 0, 'j1', 5),
            segment('seg-stub', 'j1', 5, 'j2', 5.01),
            segment('seg-high', 'j2', 5.01, 'j3', 10),
        ],
    };
    const knot = { id: 'knot-1', parentShaftId: 'seg-stub', t: 0.5, pos: { x: 0, y: 0, z: 5 } };

    const removed = collapseDegenerateJoints({
        trunks: [trunk] as never, branches: [], knots: [knot] as never,
    });

    assert.equal(removed, 1, 'the stub went');
    const ids = new Set(trunk.segments.map((s) => s.id));
    assert.ok(ids.has(knot.parentShaftId), 'the knot rides a segment that still exists');
});

test('a sole segment is kept, so its riders keep a host', () => {
    // Nothing to merge into: removing it would leave the shaft bodiless and a
    // brace knot naming an id no shaft owns, which the store cannot resolve.
    const trunk = { id: 'trunk-1', segments: [segment('seg-only', 'a', 10, 'b', 10.01)] };
    const knot = { id: 'knot-1', parentShaftId: 'seg-only', t: 0.5, pos: { x: 0, y: 0, z: 10 } };

    collapseDegenerateJoints({ trunks: [trunk] as never, branches: [], knots: [knot] as never });

    const ids = new Set(trunk.segments.map((s) => s.id));
    assert.ok(ids.has(knot.parentShaftId), 'the knot rides a segment that still exists');
});
