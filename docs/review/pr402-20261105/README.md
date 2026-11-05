# PR402 normal Web UI evidence

The coordinator performed normal mouse and keyboard interactions with the actual standalone Web Client and individually inspected these ten self-generated screenshots. The member HTTP replies and participants are synthetic. All ten files retain their original JPEG bytes; only two public filenames were normalized. No user attachments, private materials, credentials, private paths, or internal endpoints are included.

## Exact source mapping

| Client source | Served browser bundle SHA256 |
|---|---|
| `d2910c0859bf816e11d636aaef44fb383d320847` | `b9441a61987bde64190e701aeacd2c5319a52aa2a50d5c7d6e54d2a8b539aeb5` |
| `42f23625ac34c49856a3d3b62c4961e8fc033af1` | `3c28e6bafd263236517c3ce445f6a6c5d3bd7492f89b56e1f1bc4cca67252e74` |
| `d1d965365696f0eeadcb3b32b9d7ceb2c4c114d4` | `8972444b7eb249ad1d5ace3bab576455a80a51fe7839c44898d85f3ab58fe88a` |

- Four before images use `d2910c0859bf816e11d636aaef44fb383d320847`.
- Five after images use `42f23625ac34c49856a3d3b62c4961e8fc033af1`. They show removal of the two header theme buttons, the independent Web settings entry, and appearance changes with an unsaved draft.
- `after-list-light.jpg` uses final PR head `d1d965365696f0eeadcb3b32b9d7ceb2c4c114d4`. The coordinator additionally verified normal X close and Enter → Escape close return focus to Settings, while entering Account and Teams keeps focus in the new account dialog and does not steal it back to the gear.
- The final revision changes only `packages/client/src/web/entry.tsx` (15 added, 2 removed lines), for focus restoration. The five 42f images keep their exact original source attribution; their unchanged layout and appearance evidence is inherited only outside that focus change. They are not claimed to have been recaptured at the final head.

## Checked behavior and closed UI issues

- Main workbench and task detail no longer have duplicate header appearance buttons.
- Light, dark, and system appearance still use the original product store. With an unsaved draft, opening Settings and switching appearance keep the draft, selected node, and canvas in place, without a leave confirmation.
- Account and Teams still uses the original leave guard; cancelling preserves the draft. The light preference also survives a normal reload.
- The earlier draft-blocking Settings path was corrected at 42f. The remaining X/Escape focus restoration issue was corrected and separately exercised at the final head; account navigation does not restore focus to the old gear.

## Boundaries

This is actual Web Client GUI plus synthetic HTTP evidence. It does not establish Host authorization, backend persistence, model results, native desktop Settings, installation, or business execution. Desktop official Settings is not asserted to be covered by these Web images. The initial fixture lacked the task's read-only asset-list response; the selected screenshots were all taken after the fixture supplied a real-codec-valid empty response. That earlier fixture error was retained separately and is not a product defect.

The view was the default 1280 × 720 in-app browser surface. No pixel editing was performed. Source-specific normal interaction evidence is distinct from a static screenshot.

## Original-byte image inventory

| Image | Client source | Bytes | Dimensions | SHA256 |
|---|---|---:|---|---|
| [before-list-light.jpg](before-list-light.jpg) | `d2910c0859bf816e11d636aaef44fb383d320847` | 31358 | 1280 × 720 | `82d53d2068fe297b4f94683202d407231feff13cc9f65891697abd2bb062e18a` |
| [before-list-dark.jpg](before-list-dark.jpg) | `d2910c0859bf816e11d636aaef44fb383d320847` | 30051 | 1280 × 720 | `5253216794fb5ccbab8fffe5eee0fb49b97bfcbaf814c14dbc88bbbe58ffb1e6` |
| [before-detail-light.jpg](before-detail-light.jpg) | `d2910c0859bf816e11d636aaef44fb383d320847` | 54099 | 1280 × 720 | `d43cf2bd7ce00f24463d2985c42caeead23c7ca3ffa697b16c2d31a0df8f2384` |
| [before-detail-dark.jpg](before-detail-dark.jpg) | `d2910c0859bf816e11d636aaef44fb383d320847` | 52033 | 1280 × 720 | `060ac224e0bfe83044ca1f6fb0ddcbc396ae66c13a5ad9c7faee564d17c410f3` |
| [after-list-dark.jpg](after-list-dark.jpg) | `42f23625ac34c49856a3d3b62c4961e8fc033af1` | 29648 | 1280 × 720 | `77033bc897aec27445a0c2f630b575a895458f4873c4bf22c279450a75ea3ca1` |
| [after-detail-dark.jpg](after-detail-dark.jpg) | `42f23625ac34c49856a3d3b62c4961e8fc033af1` | 51822 | 1280 × 720 | `adb50dae8d271050a229db4fa51c64c21822d07e64c58857408fe2c8dd67c92f` |
| [after-detail-light.jpg](after-detail-light.jpg) | `42f23625ac34c49856a3d3b62c4961e8fc033af1` | 55342 | 1280 × 720 | `65b8ee42ac956c848810c81ca10d8b5854846c1c788e4d711d64c75dd1b4ebbe` |
| [after-settings-dirty-light.jpg](after-settings-dirty-light.jpg) | `42f23625ac34c49856a3d3b62c4961e8fc033af1` | 47013 | 1280 × 720 | `51c51549f49feef32b4bd8a470578638cb2564bf8e6a1426fa580396356eaa3c` |
| [after-settings-dirty-dark.jpg](after-settings-dirty-dark.jpg) | `42f23625ac34c49856a3d3b62c4961e8fc033af1` | 42748 | 1280 × 720 | `a703188ba5874172b6705135c39742f3fae4a511a50a23bda86a2ca7667798b4` |
| [after-list-light.jpg](after-list-light.jpg) | `d1d965365696f0eeadcb3b32b9d7ceb2c4c114d4` | 30999 | 1280 × 720 | `8b8ac30e1c1d95187fd40b7da106ec399076d47420a1666ac04d2653b84b2cc5` |
