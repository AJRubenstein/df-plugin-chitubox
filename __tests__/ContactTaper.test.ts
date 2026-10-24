import assert from 'node:assert/strict';
import test from 'node:test';

import { synthTipSettings } from '../converter/geometryHelpers';
import type { CbxTip } from '../converter/types';

const tip = (contactDiameter: number): CbxTip => ({
    x: 0, y: 0, contactZ: 12, attachZ: 10,
    socketX: 0, socketY: 0,
    length: 2, contactDiameter, bodyDiameter: 0.3, contactDepth: 0,
});

test('a contact authored narrower than its shaft is kept', () => {
    assert.equal(synthTipSettings(tip(0.15), 0.3).pointDiameter, 0.15);
});

test('a contact as wide as its shaft is narrowed', () => {
    // A thin support carries no authored taper, so the socket joint -- sized
    // above the shaft -- would stand proud of a cone that wide.
    const point = synthTipSettings(tip(0.3), 0.3).pointDiameter ?? 0;
    assert.ok(point < 0.3, `narrowed below the shaft, got ${point}`);
    assert.ok(point > 0, 'still a real contact');
});
