# History Layer Contract

## Store observations, not interpretations

The archive history layer stores audit facts about rebuilds and layout decisions. It must not store interpretive labels such as growth roles, growth colors, bridge status, or centrality algorithm outputs.

History is collected first; meaning is assigned later.

## What the history layer stores

The MVP history layer stores three append-only observation streams:

1. `archive_rebuilds`
   - one row per archive rebuild
   - rebuild id, generated time, rebuild mode, manifest schema version, record count, changed record count

2. `archive_record_snapshots`
   - one row per record per rebuild
   - observed position, layout slot, region id, score, content hash, relation count, relation weight sum, runtime/human/machine scores

3. `archive_layout_events`
   - audit-log style layout facts emitted while records are placed
   - examples: `record.first_seen`, `layout.placed`, `layout.anchor_record`, `layout.anchor_region`, `layout.slot_preserved`, `layout.moved_within_region`
   - event names are application-managed namespaces rather than database enum/check values, so new observations can be added without schema migrations

Snapshots and layout events do not carry their own `created_at` fields. Their time is the parent rebuild's `generated_at`; duplicating it on child rows would create a second timestamp that can drift from the rebuild observation.

## What the history layer does not store

The MVP history layer intentionally does not store:

- `growth_role`
- `growth_color`
- `bridge`
- centrality labels
- centrality algorithm outputs
- editorial or frontmatter-managed growth classifications

Those meanings should be derived later from accumulated observations. This preserves the ability to recalculate future growth roles from the same historical record when better algorithms or more fitting vocabularies emerge.

## Design principle

A layout event should read like an audit log entry:

```text
2026-07-07 record.first_seen post10
2026-07-07 layout.placed post10 region=internet to_slot=32
2026-07-07 layout.anchor_record post10 anchor=post3
2026-07-07 layout.slot_preserved post3 from_slot=12 to_slot=12
```

Each event is intentionally small and non-interpretive. A single event should not claim that a record is a core, bridge, or satellite. Those meanings only emerge after many rebuilds and many layout events can be queried together.
