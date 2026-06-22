import React, { useMemo } from 'react';
import * as THREE from 'three';
import { DragonfruitImportFormat } from '@/supports/types';
import { createDefaultSettings } from '@/supports/Settings/types';
import { CbxConverter, CbxModelInput } from './CbxConverter';

/**
 * Scene preview overlay for `.chitubox` imports.
 *
 * Mirrors the LYS GhostOverlay: renders a lightweight wireframe of the converted
 * support structure (root markers, shaft segments, joints, contact-cone tips) so
 * the user can confirm placement before/while importing.
 *
 * Difference from the LYS overlay: the LYS converter accepts the raw scene blob,
 * so its overlay calls `LysConverter.convert(rawData, ...)` inline. The Cbx
 * converter consumes a PARSED model (`CbxModelInput`) produced by the binary
 * parser, not a raw file. To keep the same host-facing `{ data, visible }` prop
 * contract while accommodating that, this overlay accepts `data` in any of three
 * shapes and normalizes to a `DragonfruitImportFormat` for rendering:
 *   - an already-converted `DragonfruitImportFormat` (has `.trunks`)
 *   - a single parsed `CbxModelInput` (has `.supports`)
 *   - an array of parsed models
 */

interface GhostOverlayProps {
  data: any;
  visible: boolean;
}

/** Type guard: already-converted import format. */
function isImportFormat(d: any): d is DragonfruitImportFormat {
  return !!d && Array.isArray(d.trunks) && Array.isArray(d.roots);
}

/** Type guard: a parsed model bundle the converter can consume. */
function isModelInput(d: any): d is CbxModelInput {
  return !!d && Array.isArray(d.supports) && typeof d.index !== 'undefined';
}

/** Normalize whatever the host passes into a single import-format payload. */
function toImportFormat(data: any): DragonfruitImportFormat | null {
  if (!data) return null;

  if (isImportFormat(data)) return data;

  const settings = createDefaultSettings();

  // Single parsed model.
  if (isModelInput(data)) {
    return CbxConverter.convert(data, settings);
  }

  // Array of parsed models → convert each and merge into one payload for preview.
  if (Array.isArray(data) && data.every(isModelInput)) {
    const merged = CbxConverter.convert(data[0], settings);
    for (let i = 1; i < data.length; i++) {
      const part = CbxConverter.convert(data[i], settings);
      merged.roots.push(...part.roots);
      merged.trunks.push(...part.trunks);
      merged.branches.push(...part.branches);
      merged.leaves.push(...part.leaves);
      merged.knots.push(...part.knots);
      if (part.twigs) (merged.twigs ??= []).push(...part.twigs);
      if (part.sticks) (merged.sticks ??= []).push(...part.sticks);
      merged.braces.push(...part.braces);
    }
    return merged;
  }

  // A parsed container with a `.models` array.
  if (data && Array.isArray(data.models) && data.models.every(isModelInput)) {
    return toImportFormat(data.models);
  }

  console.warn('[cbx-ghost] Unrecognized overlay data shape; nothing to render.');
  return null;
}

export function GhostOverlay({ data, visible }: GhostOverlayProps) {
  const convertedData: DragonfruitImportFormat | null = useMemo(() => {
    if (!data) return null;
    console.log('[cbx-ghost] Building preview...');
    return toImportFormat(data);
  }, [data]);

  const ghostGeometry = useMemo(() => {
    if (!convertedData) return [];

    const items: React.ReactNode[] = [];

    convertedData.trunks.forEach((trunk) => {
      // Render shaft segments.
      trunk.segments.forEach((seg) => {
        const startPos = seg.bottomJoint
          ? seg.bottomJoint.pos
          : seg === trunk.segments[0]
            // First segment with no bottomJoint connects to the Root.
            ? convertedData.roots.find((r) => r.id === trunk.rootId)?.transform.pos
            : null;

        const endPos = seg.topJoint ? seg.topJoint.pos : null;

        if (!startPos || !endPos) return;

        const s = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
        const e = new THREE.Vector3(endPos.x, endPos.y, endPos.z);

        items.push(
          <line key={`line-${seg.id}`}>
            <bufferGeometry>
              <float32BufferAttribute
                attach="attributes-position"
                args={[new Float32Array([s.x, s.y, s.z, e.x, e.y, e.z]), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color="yellow" opacity={0.5} transparent depthTest={false} />
          </line>,
        );

        if (seg.topJoint) {
          items.push(
            <mesh key={`joint-${seg.topJoint.id}`} position={[e.x, e.y, e.z]}>
              <sphereGeometry args={[0.4, 8, 8]} />
              <meshBasicMaterial color="orange" depthTest={false} transparent opacity={0.8} />
            </mesh>,
          );
        }
      });

      // Render root marker.
      const root = convertedData.roots.find((r) => r.id === trunk.rootId);
      if (root) {
        items.push(
          <mesh
            key={`root-${root.id}`}
            position={[root.transform.pos.x, root.transform.pos.y, root.transform.pos.z]}
          >
            <sphereGeometry args={[0.6, 8, 8]} />
            <meshBasicMaterial color="red" depthTest={false} transparent opacity={0.8} />
          </mesh>,
        );
      }

      // Render contact-cone tip.
      if (trunk.contactCone) {
        const p = trunk.contactCone.pos;
        items.push(
          <mesh key={`cone-${trunk.contactCone.id}`} position={[p.x, p.y, p.z]}>
            <sphereGeometry args={[0.3, 8, 8]} />
            <meshBasicMaterial color="cyan" depthTest={false} transparent opacity={0.8} />
          </mesh>,
        );
      }
    });

    return items;
  }, [convertedData]);

  if (!visible || !convertedData) return null;

  return <group>{ghostGeometry}</group>;
}
