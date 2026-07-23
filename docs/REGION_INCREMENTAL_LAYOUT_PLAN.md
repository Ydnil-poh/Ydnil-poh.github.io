# Region Incremental Layout Plan

## Goal

Keep the current incremental layout behavior for records while splitting the global field into tag-based Regions.

The retained behavior is:

- Existing records keep their persisted `layoutSlot` whenever possible.
- New records are placed by choosing the nearest semantic anchor and then finding the nearest open slot.

The changed behavior is:

- A record is placed only inside the Region associated with its single tag.
- Region placement, Region size, and Region occupancy are persisted and maintained independently of record placement.

## Region Model

Every public record must have exactly one tag. The tag defines the record's Region.

A Region is persisted with:

- `id`: stable Region identifier, for example `tag:뚜벅뚜벅`.
- `tag`: the source tag.
- `seedSlot`: stable spatial anchor for the Region.
- `seedPosition`: normalized position derived from `seedSlot`.
- `footprint`: the cells occupied by the Region.
- `stats`: density and occupancy metrics.

The implementation should not depend directly on rectangle-specific fields such as `minCol` or `maxCol` outside the footprint adapter. Initial footprints may be rectangular, but all layout logic must go through the footprint abstraction.

## Footprint Abstraction

A Region's occupied space is represented as a `footprint`, not as a hard-coded rectangular boundary.

Initial manifest shape:

```json
{
  "schemaVersion": 1,
  "kind": "rect",
  "rect": {
    "minCol": 12,
    "maxCol": 18,
    "minRow": 3,
    "maxRow": 9
  }
}
```

Future shapes can include cell sets or masks:

```json
{
  "schemaVersion": 1,
  "kind": "cells",
  "cells": [213, 214, 215, 253, 254, 255]
}
```

All consumers should use helper APIs:

- `slotsInFootprint(footprint, profile)`
- `isSlotInFootprint(slot, footprint, profile)`
- `footprintArea(footprint, profile)`
- `nearestOpenSlotInFootprint(preferredSlot, occupied, footprint, profile)`
- `footprintIntersects(a, b, profile)`
- `expandFootprint(footprint, context)`
- `shrinkFootprint(footprint, context)`

This keeps the first implementation simple while preserving a path to non-rectangular Regions.

## Region Bootstrap

Region bootstrap runs only when no Region seeds exist in the previous manifest.

Bootstrap steps:

1. Group records by tag.
2. Compute one centroid embedding per Region.
3. Run `projectEmbeddings()` only on Region centroids.
4. Convert projected centroid positions to Region seed slots.
5. Resolve seed collisions with nearest-open-slot behavior.
6. Create initial footprints around seeds.
7. Persist Region seeds and footprints in the manifest.

Record-level global projection should not run after Region seeds exist.

### Projection Axes Are State

The 2D projection selects its two axes by variance ranking, and that ranking is
unstable while the archive is small: adding a handful of records can reorder it.
To keep bootstrap and reseed events reproducible, the selected axes are persisted
in the manifest as `embeddingProjection` and carried forward verbatim on every
build.

- Builds reuse the persisted `xAxis`/`yAxis`; variance is not re-ranked.
- Axes are selected from record embeddings (matching `analyze-embedding.mjs`
  diagnostics), not from Region centroids.
- A fresh selection happens only when the persisted state is unusable
  (embedding model or dimension change, invalid axes) or explicitly requested
  via `--recalculate-projection` / `ARCHIVE_RECALCULATE_PROJECTION=1`.
- `--region-reseed` relocates Regions on the *pinned* axes; combine it with
  `--recalculate-projection` to re-derive the projection as well.

## New Region Creation

When a new tag appears:

1. Compute the new Region's centroid embedding.
2. Compare it with existing Region centroid embeddings.
3. Select the closest Region as the primary anchor.
4. Search near the anchor Region's `seedSlot` for an open Region seed position.
5. Create an initial footprint that does not intersect existing Region footprints.
6. Persist the new Region seed and footprint.

Region seeds should remain stable after creation unless an explicit maintenance policy changes them.

## Existing Region Maintenance

General builds must not resize existing Region footprints.

During a general build:

- Existing Region seeds remain fixed.
- Existing Region footprints remain fixed.
- Region centroid drift does not move the Region seed.
- Region stats may be recalculated and persisted.

## Record Placement

During a general build:

1. Read the record's single tag.
2. Resolve the tag to a Region.
3. Preserve existing records' persisted `layoutSlot` whenever possible.
4. For new records, find semantic anchors only among records in the same Region.
5. Use the anchor slot as the preferred slot.
6. Call `nearestOpenSlotInFootprint()` so the record cannot leave its Region footprint.

If a Region has no open footprint slot during a general build, the build should fail or defer placement rather than silently placing the record outside the Region.

## Density Policy

Region size is maintained by density rather than by raw post count.

For each Region:

- `occupiedSlots`: number of Region records whose slots are inside the footprint.
- `availableSlots`: `footprintArea - occupiedSlots`.
- `density`: `occupiedSlots / footprintArea`.
- `targetDensity`: `0.72`.

Suggested maintenance thresholds:

- Expand above `0.82` density.
- Shrink below `0.48` density.
- Otherwise leave the footprint unchanged.

The threshold band prevents constant resizing around the 72% target.

## Sleep Rebuild

Sleep Rebuild is maintenance, not a global terrain reprojection.

Sleep Rebuild may:

- Recalculate Region density.
- Expand over-dense Region footprints.
- Shrink sparse Region footprints.
- Repack empty space within a Region footprint.
- Resolve overflow or collision issues within a Region.

Sleep Rebuild should not:

- Reproject all records globally.
- Move Region seeds by default.
- Place records outside their Region footprint.
- Expand a Region footprint into another Region's footprint; if one expansion
  direction is blocked, skip that direction and still allow the other safe
  directions.

Any record movement during Sleep Rebuild should be local to the Region and should use existing slots as preferred positions.

## Manifest Changes

Bump the manifest schema version when Region persistence is introduced.

The field view should include Regions:

```json
{
  "schemaVersion": 2,
  "cols": 40,
  "rows": 25,
  "regions": [],
  "records": []
}
```

Each field record should include its Region:

```json
{
  "id": "post1",
  "slot": 213,
  "col": 13,
  "row": 5,
  "regionId": "tag:뚜벅뚜벅",
  "isLatest": false
}
```

Raw embeddings must not be stored in the manifest. Region centroids are recomputed at build time and only Region seeds, footprints, and stats are persisted.

## Implementation Phases

1. Add footprint utilities and a rectangular footprint adapter.
2. Add tag validation and Region grouping.
3. Add Region centroid calculation.
4. Add Region bootstrap from centroid projection.
5. Persist Region seeds, footprints, and stats.
6. Replace global incremental record placement with Region-scoped incremental placement.
7. Add new Region creation from nearest Region anchor.
8. Add Sleep Rebuild mode for footprint maintenance.
9. Extend tests for Region seed persistence, Region-scoped placement, density calculation, and Sleep Rebuild-only resizing.

## Test Coverage

Add tests that verify:

- A manifest without Regions bootstraps Region seeds from Region centroids.
- Existing Region seeds remain stable when centroid embeddings drift.
- New Regions are created near their nearest Region anchor.
- New records are placed only inside their Region footprint.
- Existing records preserve `layoutSlot`.
- Density is computed from footprint slots.
- General builds do not resize footprints.
- Sleep Rebuild can resize footprints without changing Region seeds.
- The footprint API works for `rect` without leaking rectangle-specific assumptions into layout code.
