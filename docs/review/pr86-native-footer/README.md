# PR86 native account footer evidence

These ten images are actual official Electron WebContents captures using fictional test accounts and private JSON storage. The current prepared official main and forwarding helper were bundled through the official build configuration. Unchanged fixed libraries and preloads were reused; the existing neutral-sidebar patch was rebuilt in the isolated tree. This is a development validation build, not an installer proof.

Source6054 and equivalentcdd have identical Client, Host and native production bytes; cdd changes only a browser-test readiness assertion. Every image checksum and exact viewport is recorded in manifest.json. Themes are selected through official Settings. The long navigation capture uses real registry records and a real wheel scroll; no DOM rows are duplicated. No user reference image, personal path, credential or private account data is included.

The two landing captures demonstrate the open P2 in review5639775292: member-mode cold start/reload still selects the old workbench and shows snapshot HTTP404. They are failed states, not acceptance. Issue31 and PR86 remain open/Draft until the normal entry and remaining exits are verified. Existing Web before/after comparisons remain separate in the PR body.
