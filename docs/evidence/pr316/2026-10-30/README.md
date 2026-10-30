# PR 316 desktop session layout evidence

Fourteen original PNG captures of the actual official desktop application, using only isolated fictional data. The six before/after pairs share the same saved task/history, theme and viewport. Expanded captures show the complete retained task instructions and keyboard-reachable scroll areas.

Before: product source `49d2d1ba5d8be54764add30510b718a6afc95389`, released v1.2 tree `50454fc574386d5077c28c21cc499e039a864737`, official RC.2 runtime.

After: Client source `d2b7bf37542d72be400b35ff48d13ec853b15fc1`, official RC.4 `504a01a9578abc2c6f1fb896b1dc322c9fe24f66`, and the explicit PR 320 cold-start overlay. Exact bundle hashes and file checksums are in `manifest.json`. These runtime compositions differ as recorded; the captures do not imply ACP/CodeArts or team-asset acceptance.

The reviewed change removes repeated width limits, aligns the header/settings/history, and folds long initial task instructions while retaining their complete text. Main desktop pairs are 1280×800, 1440×900 and 1920×1080 in both themes. The two additional captures show expanded instructions at 1280×800 and the 1024×768 desktop narrow-window boundary. Images are visual evidence; behavior, source, CI and real model evidence are recorded separately in the PR.
