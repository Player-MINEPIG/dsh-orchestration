# Task center text selection, 0.2.49

The task center polls every three seconds. Its fingerprint includes node observations, so heartbeat changes triggered `app.innerHTML` replacement even when the visible task text had not changed. Removing the selected text nodes cleared the browser selection. The browser document itself did not reload.

Snapshot rendering now compares and updates DOM nodes within the same view. Unchanged subtrees and text nodes remain in place. Task cards and status columns have stable keys; matching stays within one parent. Attributes and text are written only when their values change. If a list move disturbs a selection, the renderer restores its original node offsets only while both original text nodes remain connected and unchanged. Changed or deleted text does not restore an obsolete selection. Navigation and explicit actions retain their existing rendering behavior. Form focus and non-task dialogs retain their polling protection.

The elapsed-time updater also skips unchanged text and edits the existing text node when its value changes. No dependency was added. The first temporary implementation deferred rendering during selection; it was replaced before commit and deployment by the incremental renderer requested by the user.

The package build passed. The existing VM suite passed 63 of 65 cases. Its two failures also occur with the installed 0.2.48 baseline and remain unchanged:

- `executor page shows a persistent role explanation without false zero task counts or repeated role requests`
- `owned UI wording uses execution language while inbox remains waiting rather than running`

The VM harness continues testing page and command behavior with string-backed DOM stand-ins. Its `patchHtml` stand-in does not claim DOM coverage. `scripts/validation/task-center-selection-browser.mjs` runs the real renderer in Chrome. `browser.json` records the original selection loss and the corrected behavior through heartbeat polls, another task's state/content update, insertion, reordering, read failure and recovery. It also checks selected report text while other details change, the first task click, removal/change of selected text, and unchanged elapsed-time nodes. These isolated fixtures do not create production tasks.

To rerun the browser check after building, provide an existing Playwright module and Chrome installation:

```sh
DSH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
DSH_BASELINE_PROJECT_PAGE=/absolute/path/to/previous/project-page.html \
node scripts/validation/task-center-selection-browser.mjs
```

The baseline argument is optional. Output defaults to `/private/tmp/dsh-task-center-selection`.

The initial main checkout was clean at `9e6f435`, matching `origin/main`. Both deployed 0.2.48 installations matched all 325 files from the recorded archive for committed source `67662d2`; no uncommitted deployed source needed recovery. Development used branch `codex/task-center-text-selection` at `/private/tmp/dsh-task-center-text-selection`. Source commit `cc1b8fc` was pushed to the existing GitHub `main` before the AWS update, as the user requested. The existing WIP stash remains at `2b6330cecdba7eab3a1aab82f081686e2df85f3e`, currently `stash@{0}`.

MBP runs 0.2.49 and passed package, configuration-preservation and health checks. `live-mbp.json` records a selected sentence remaining selected in the actual authenticated task center while its queue-observation timestamp advanced by twenty seconds. The served iframe contains the incremental renderer. This live check used existing records and did not submit a business action.

AWS runs the same 0.2.49 archive after cloning the existing GitHub repository at `cc1b8fc`, installing the locked build dependencies and building on AWS. The locally built and AWS-built archives have the same SHA256 `3688b3b727ea05e0bdae5ab8b1bc60df858f67ae3b3f7bf73f1a20d6b79cdb7d`. The existing deployment helpers on each host made backups, preserved configuration and credentials, checked business records, and activated the existing web service. `release.json` records the package and health receipts. No new GitHub credential was installed on AWS.

Automatic approval initially rejected uploading the private archive/helpers to AWS. That command did not execute. The user then requested GitHub delivery; the fix was pushed to the existing repository and AWS obtained and built it from there. No archive or helper was uploaded to AWS.

The authenticated AWS task center also served the incremental renderer and retained a native text selection for forty seconds across live polling. `live-aws.json` records the observation. Production task data did not change during that interval; simultaneous visible updates are established by the isolated Chrome cases and the advancing live MBP queue timestamp. No production task was dispatched, retried or edited for verification.
