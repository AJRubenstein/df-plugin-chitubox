import assert from 'node:assert/strict';
import test from 'node:test';

import { toGraphRecords } from '../converter/ctpGraphAdapter';
import { buildSupportGraph } from '../converter/supportGraph';
import { emitFromGraph } from '../converter/graphEmit';
import type { PoolRecord } from '../CtpParser';

const rec = (over: Partial<PoolRecord>): PoolRecord => ({
    role: 3, sub: 7,
    x: 0, y: 0, topZ: 10,
    x2: 0, y2: 0, botZ: 0,
    paramA: 0.4, paramB: 0.4, extra: 0,
    ...over,
});

test('role carries the taxonomy, not sub', () => {
    // .ctp writes a constant sub per role; the graph reads role as its `sub`.
    const out = toGraphRecords([
        rec({ role: 12, sub: 7 }),
        rec({ role: 3, sub: 7 }),
        rec({ role: 9, sub: 1 }),
    ]);
    assert.deepEqual(out.map((r) => r.sub), [12, 3, 9]);
});

test('a downward contact reads as a tip', () => {
    // role 2 is a cone hanging below its socket -- .chitubox authors the same
    // thing as a tip, which is how the emitter finds a stick's foot.
    const [out] = toGraphRecords([rec({ role: 2, topZ: 1, botZ: 3 })]);
    assert.equal(out.sub, 1);
});

test('a twig survives to the emitter', () => {
    const records = [rec({
        role: 12,
        x: 0, y: 0, topZ: 5,
        x2: 1, y2: 0, botZ: 5,
        paramA: 0.15, paramB: 0.15,
    })];
    const graphRecords = toGraphRecords(records);
    const emitted = emitFromGraph(buildSupportGraph(graphRecords), graphRecords);
    assert.equal(emitted.twigs.length, 1, 'twig emitted');
    assert.equal(emitted.twigs[0].diameter, 0.3);
});

test('a pillar standing on the model becomes a stick', () => {
    // Ungrounded shaft, a contact above and a contact hanging below.
    const records = [
        rec({ role: 3, x: 0, y: 0, topZ: 8, x2: 0, y2: 0, botZ: 5 }),
        rec({ role: 1, x: 0, y: 0, topZ: 9, x2: 0, y2: 0, botZ: 8, paramA: 0.1, paramB: 0.4 }),
        rec({ role: 2, x: 0, y: 0, topZ: 4, x2: 0, y2: 0, botZ: 5, paramA: 0.1, paramB: 0.4 }),
    ];
    const graphRecords = toGraphRecords(records);
    const emitted = emitFromGraph(buildSupportGraph(graphRecords), graphRecords);
    assert.equal(emitted.supports.length, 1);
    assert.ok(emitted.supports[0].downwardTip, 'the support carries a downward contact');
});
