# Revision client UI evidence

Same fictional data, 1440 x 900 viewport, light and dark themes. PNGs are full-page captures from actual component source.

Baseline: `33c081e9155a88e0ef6745a80218de138a77d09d`. Implementation: `785d9cf27070053bff6f3e85bc40d4eb2bb2122c`. Captured at `9a5bc5fb92da13d92c699344c31afd99cf89574d`; implementation changes only test waits, all product/harness/fixture/CSS blobs are identical.

Normal inbox revise opens a blank delivery form before this change; afterward it shows fixed returned/previous versions and named notes. Expanded picker and previous-version selection are new states, with no equivalent baseline.

These are local HTTP response replays with fictional members and review data. They do not certify a real identity/execution service, persistence, Native, file bytes, models, or a complete multi-user workflow. See manifest.json for SHA-256 and dimensions.
