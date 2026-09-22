# OpenHistory Focus

OpenHistory Focus is a fork of [OpenHistory](https://github.com/ztratar/openhistory) for macOS. It
adds a calm focus companion on top of OpenHistory's private, local activity collector:

- **Goals**: what you're working toward, why it matters, and your current focus.
- **Focus sessions**: pick a goal, write an intention, choose 25, 50 or a custom number of
  minutes, and list the sites that tend to pull you away.
- **A gentle reminder**: during a session, if a listed site is the front browser tab, a thin warm
  amber edge fades in around that display with a small reminder card near the top: your goal and
  intention, plus **Snooze 5 min** and **Dismiss**. Optionally, grayscale can show only the
  distracting window, that whole display (both captured), or every display (System, through
  macOS Color Filters) in gray,
  with or without the amber edge (see [Reminder styles](#reminder-styles)).
- **An Activity timeline**: a model-free, chronological view of each recorded day.

Focus **nudges; it never blocks**. Every site stays reachable, and nothing is closed, hidden or
redirected.

## Setup

Requirements: macOS 14 or later, Node.js 22, Xcode with Swift 6.1 or later.

```bash
npm ci
npm run build            # native bridge (Swift + N-API) and Electron bundles
npm run dev              # development run
npm run desktop:package:local:host   # runnable ad-hoc-signed app for this Mac's architecture
npm run desktop:package:local        # same, with universal (arm64 + x86_64) native components
```

The packaged app is written to `.todesktop/local/…/OpenHistory Focus.app`.

For reliable macOS permission testing, open the packaged app from Finder. A command-line
`npm run dev` launch can be attributed to its terminal or development host rather than Electron.
In System Settings → Privacy & Security → Accessibility, click **+**, press **Command–Shift–G**,
enter the absolute packaging output folder, and select **OpenHistory Focus.app**. Enable its
switch, return to the companion and choose **Check again**. The Focus page should say
**Ready to notice listed sites**. Permission for upstream OpenHistory or a separate Electron
installation does not establish permission for this bundle. Local builds are ad-hoc signed;
a rebuild or a move may require adding the app again. For a stable local development identity,
set `OPENHISTORY_FOCUS_SIGN_IDENTITY` to an installed Apple Development identity when running
the packaging command. The identity must remain the same across updates. This is local signing,
not Developer ID distribution or notarization. Distributed builds need their own signing setup.

If a site does not trigger a reminder, check that a session is running, the site is listed,
capture is on, and snooze is off. The 2-second cooldown also applies when returning to a site.
**Test reminder** checks the overlay independently of browser detection.

If macOS logs a code-requirement mismatch after switching from an ad-hoc build to a signed
build, install the signed app in `/Applications` first. Quit the app, then reset only this fork’s
stale approval with `tccutil reset Accessibility io.github.cliffordfajardo.openhistory-focus`.
Reopen it and grant Accessibility again. This removes the old grant; it does not grant access
or delete activity. Do not reset permissions for unrelated apps. Keeping the same signing
identity and installed bundle identifier avoids the original per-build hash requirement.

First launch:

1. **Privacy notice.** Capture stays paused until you accept it.
2. **Summaries.** Choose **Keep everything local — summaries off** to finish without any model,
   API key or cloud consent. Summary models (Apple on-device, or a cloud provider after an
   explicit disclosure) remain available and can be turned on later in Settings.
3. **Capture.** Only app switches, window titles and browser addresses are recorded by default.
   Email and messaging stay excluded unless you select them.
4. **Accessibility.** Grant access when prompted (or later in Settings). It is how the front
   browser tab's address and window titles are read.

## Using Focus

1. Create a goal on the **Goals** tab (title, why it matters, current focus).
2. On **Focus**, add distracting sites (for example `youtube.com`). A rule covers the site and its
   subdomains (`m.youtube.com`), and nothing else (`notyoutube.com` and
   `youtube.com.example.net` do not match).
3. Choose the goal, write an intention, pick a duration and press **Start focus**. Adding or removing sites during a session applies immediately, without resetting its timer or bypassing snooze.
4. Use **Test reminder** at any time to see the real reminder on this display. The preview works
   without Accessibility or capture, and it doesn't affect a running session.

Reminder timing:

| Behavior | Value |
| --- | --- |
| Fade in; manual snooze/dismiss fade out | about 0.6 s (static when Reduce Motion is on) |
| Automatic hide | stays while the listed site is active; hides immediately when changed foreground evidence arrives. App switching also hides through a native activation notification. |
| Preview | hides after about 8 s |
| Minimum time between reminders | 2 s (requested for testing) |
| After **Dismiss** | at least 60 s of quiet |
| **Snooze** (card, Focus page or menu-bar icon) | 5 minutes for all reminders; **Resume** ends it early |
| Evidence freshness | a foreground observation older than 3 s is treated as unknown |
| Idle | no reminders while macOS reports 120 s or more without input |

Sessions live only in memory. Quitting or restarting the app ends the session; it never resumes on
its own. Goals and the site list are saved.

## What Focus can and can't notice

Reminders need all of the following. The Focus page shows which one is missing.

- Capture running (not paused). Pause persists across launches.
- Accessibility access for OpenHistory Focus.
- **Browser URLs** enabled in Settings → Capture details.
- The native reminder built into the app (it is part of `openhistory-native.node`).

Browser support:

| Browser | Status |
| --- | --- |
| Google Chrome | YouTube detection verified in the packaged Apple Silicon build on the development Mac. |
| Safari | Targeted; real browser verification pending. |
| Chrome-installed web apps | Recognized when the focused window exposes a readable website URL; YouTube verified in the installed development-signed build. |
| Chrome Beta/Canary, Microsoft Edge, Brave, Arc, Firefox, Chromium, Vivaldi, Opera | Experimental: recognized by the existing collector, and reminders may work, but they are not yet verified. Firefox often exposes no readable address. |
| Anything else (including Electron apps such as Figma, Linear, Notion) | Not observed by Focus. |

Focus treats every uncertain state as "unknown" and does not remind:

- detected private or incognito windows, adult sites, and messaging pages unless you opted in;
- unreadable addresses (for example while a page is loading or in non-English browser UIs where
  the address field isn't found);
- excluded apps, password managers, notification overlays and OpenHistory Focus itself;
- a locked screen, sleeping display, or an idle Mac.

Webmail hosts such as `mail.google.com` can trigger a listed-site reminder even when email
activity recording is off. Focus uses the hostname only. Email URL paths, page titles, message
text and other email activity remain excluded from recorded history under that setting. This
does not enable detection of native Mail or Outlook apps. If you select Window or Screen
grayscale, its existing transient screen processing also applies to webmail; System grayscale
and the amber edge need no screen capture.

Private-window detection is heuristic and depends on the browser’s exposed accessibility
information. It is not a universal guarantee across browser versions or languages.

## Reminder styles

Under **Focus → Reminder style**, the **Amber edge** switch and the **Grayscale** choice are
independent. Both are saved in `focus.json` and apply immediately, including to a running
session: a visible reminder is replaced in the new style without waiting for the cooldown, while
the session's goal, timer, site list, snooze and dismiss quiet period are kept.

- **Amber edge** (on by default): the warm edge described above. It needs no permission beyond
  Accessibility. Above a captured gray image it is drawn over the gray, and the card above both.
  Files saved before the switch existed keep their look: it is on for the old amber style and off
  for the old grayscale styles.
- **None** (stored as `experience: "amber"`, its name from before the edge was separate): colors
  are unchanged.
- **Window**: while a reminder shows, only the distracting browser window is shown in
  grayscale; the rest of the display, other windows and other displays stay in color. For a
  preview, the Focus window itself stands in for the distracting window. It needs macOS Screen
  Recording access (the same permission as Screen).
- **Screen**: while a reminder or preview is showing, the **entire display** that holds
  the distracting window (for a preview, the display with the Focus window) is shown in grayscale.
  Other displays stay in color. The reminder card, Snooze and Dismiss are the same; the card and
  any OpenHistory Focus panels stay in color above the gray image. It needs macOS Screen
  Recording access.
- **System** (experimental): macOS Color Filters set to grayscale. Every display turns gray,
  including the reminder card and amber edge. No Screen Recording, no frames captured. See
  [System grayscale](#system-grayscale).

How grayscale works: `FocusGrayscale.swift` captures that display with ScreenCaptureKit at up to
30 fps (the real cursor stays visible; the captured one is off), desaturates each complete frame
with Core Image on the GPU and draws it into a Metal layer in a click-through, nonactivating panel
below the amber edge and the card. The capture filter excludes this app's own overlay panels,
including the edge, so they never feed back into the gray image (by excluding the
app and listing its visible normal windows as exceptions, so the Focus window still appears under
the gray image). The panel appears only after the first captured frame is rendered; before that,
the Focus page says "Starting grayscale" rather than claiming it is shown. Window and Screen use
no system display setting, private API or Shortcut, and nothing changes after the app quits or
crashes.

How grayscale window works (`FocusWindowGrayscale.swift`): this is an overlay built from a public
screen capture, not a system filter. The target is the browser's focused window from Accessibility
(position and size, not minimized), matched to exactly one on-screen, normal-level window of the
same process with the same bounds in the window server's list. No match, several matches, or a
window on more than one display is not guessed at. The capture uses the same display filter as
Grayscale screen (the composited display without this app's panels, so menus and windows in front
are captured as they appear) with a `sourceRect` cropped to that window, sized in the display's
pixels. It never captures a single window on its own, which could redraw hidden content over
menus or other windows. Coordinates are converted between the window server's top-left origin
and AppKit's bottom-left origin per display, including displays left of or above the main one
and Retina scale. A window partly off every display is cropped to its visible part.

Following the window:

- The gray image appears only after the first captured frame **and** the next foreground check
  from the existing 0.75 s sampler confirms that the same window still shows the reminder's site.
  If no confirmation arrives within 2 s, the reminder uses the amber edge.
- Moving or resizing the window hides the gray image at once (Accessibility move/resize
  notifications for that window only). About 0.2 s after the window stops moving, its bounds are
  verified again and capture restarts for the new rectangle. Unchanged bounds don't restart it.
- Switching to another window of the same browser, minimizing or closing the window hides the
  gray image at once. It returns only when a new foreground check, read from the newly focused
  window, shows the same listed site; a safe site in that window never turns gray. A different
  listed site in the new window keeps the reminder but switches it to the amber edge.
- App switches, Space and full-screen transitions hide the reminder as before. A display
  change hides the gray image and verifies the bounds again. In a preview, the gray image hides
  while another app is in front and returns when the Focus window is in front again. A preview
  window moved to another Space falls back to amber.
- The cooldown, snooze, dismiss quiet period, 8 s preview and stop/quit cleanup are unchanged.

When captured grayscale can't run, the reminder shows without it (the card, plus the edge only if
the switch is on) and the Focus page says why:
Screen Recording not allowed, capture unsupported, capture stopped (including revoking access
while it runs), no frame within 4 s, the display changed, the distracting window couldn't be
matched or followed exactly, or the window is on more than one display. The whole display is
never grayed in place of a window. A fallback lasts until that reminder hides. Hiding a reminder
removes the gray panel synchronously and then stops capture, so a late capture callback can't
bring it back.

### System grayscale

**Experimental.** This option sets macOS Color Filters (the setting under **System Settings →
Accessibility → Display → Color Filters**) to grayscale through private MediaAccessibility calls,
loaded at runtime. They are undocumented, unsupported by Apple and may break in any macOS
update; they were tested on macOS 26.6.2 (arm64). Where they can't be loaded, the option is
unavailable and a saved choice shows the card (and edge, if on) without grayscale. No setup,
permission, capture, Shortcut or UI automation is involved.

- The setting is system-wide and persisted: every display turns gray, including the reminder
  card and amber edge, and it survives until changed back.
- When a reminder or preview shows, the app reads the current Color Filters settings (on/off and
  filter type) and, before changing anything, saves them to a private restore journal at
  `~/Library/Application Support/OpenHistory Focus/focus-color-filter-restore.json`, outside the
  activity data folder so deleting data can't remove it first. Only then is grayscale written.
  If the settings were already grayscale, nothing is changed or journaled.
- When the reminder hides, is snoozed or dismissed, the session stops, the preview ends, the
  style changes away from System, or the app quits, the earlier settings are put back exactly
  (for example, a different filter left on stays on). If you changed Color Filters yourself
  while the reminder showed, your change is kept. Either way the journal is then removed.
- Writes are synchronous and happen on transitions; active reminders re-read the setting to notice manual changes. The status reports what
  macOS says the setting is, not when the screen visibly changes.
- If a turn-on fails, the reminder shows without grayscale and the page says so. If a restore
  fails, the journal is kept, no new turn-on happens, and **Restore previous colors** retries.
- **After a crash or force quit while gray, the screen stays gray until the app next opens**,
  when restoration is attempted before new reminders, or until you switch Color Filters off in
  System Settings.

If the journal is unreadable, the app cannot safely infer your previous settings and leaves restoration to you in System Settings. Manual changes are detected from settings snapshots; changes away and back between observations cannot be distinguished.

A possible future App Store-friendly alternative is Apple's public Shortcuts Color Filters
action, run through user-made shortcuts. It is not implemented.

## Permissions

- **Accessibility** powers OpenHistory's collector and every reminder.
- **Screen Recording** is used only by the optional Window and Screen grayscale; one grant covers
  both. The amber edge and System grayscale need
  no Screen Recording: it picks its display from the front window's Accessibility geometry,
  falling back to on-screen window bounds for that process (bounds are available without Screen
  Recording). Access is checked without prompting. **Grant Screen Recording** asks macOS once per
  launch; afterwards the page offers **Open Settings** and **Check again**. macOS may ask you to
  quit and reopen the app after granting. No capture starts unless access is already granted.
  While grayscale runs, macOS shows its screen-recording indicator; newer macOS versions may also
  ask periodically whether to keep allowing it.
- No AppleScript/Automation, no browser extension, and no second activity tracker.

## Privacy

- **One collector.** Focus reuses the existing embedded Swift sampler (every 0.75 s while capture
  runs). It adds nothing while no session is active.
- **Ephemeral evidence.** During a session the sampler also sends a small tagged packet: either
  "browser: process, bundle, host" or "unknown: reason". Packets go straight to the main process
  and are **never written** to the activity files or to the 250-event live buffer. The URL,
  window title and page content are not in the packet.
- **Checked twice.** Swift and TypeScript apply a separate Focus policy that allows webmail
  hostnames without enabling email activity recording. Private-window and other Focus exclusions
  still produce "unknown". The activity-recording policy and its email opt-in stay unchanged.
- **Local data.** Everything lives in `~/Library/Application Support/OpenHistory Focus/activity-data`
  (mode 0700): activity JSONL, `focus.json` (goals and sites), settings and any summaries. Upstream
  OpenHistory's directory, environment variables, keys and consents are never read.
- **Minimal defaults.** App switches, window titles and browser addresses only. Text input,
  focused controls, clicks, documents, interface snapshots, email and messaging are off until you
  turn them on.
- **Summaries off by default.** No model runs and nothing leaves the Mac unless you enable
  summaries. Cloud providers still require their own key and an explicit disclosure.
- **Local MCP.** The authenticated read-only MCP server listens on `127.0.0.1:47841` (upstream
  uses 47831). Goals and Focus data are not exposed through MCP or sent to any model.
- **No upstream updater.** The ToDesktop auto-updater is not initialized, so upstream builds can't
  replace this app. Releasing through ToDesktop requires a fork-owned app ID in
  `OPENHISTORY_FOCUS_TODESKTOP_ID`.
- **Delete everything.** Settings → Data & privacy → Delete all local data removes activity, goals,
  preferences, summaries, settings, keys and agent connections after a native confirmation.
- **Grayscale frames are transient.** They exist only in ScreenCaptureKit/GPU memory while a
  grayscale reminder shows. They are never written to disk, logged, copied to JavaScript,
  analyzed or sent anywhere, and the capture stream and panel are released when it hides.
  Grayscale window reads only window geometry (bounds, window number, owner process) to find the
  window; the listed site rule it compares against is passed in memory with the reminder and
  never stored.
- **Diagnostics** include counts and states only (number of goals and sites, whether a session is
  active), never goal text or site names.

## Activity timeline

**Timeline → Activity** reads the persisted file for one local day on demand (not the 250 most
recent events), sorts it chronologically, and shows app, window title and site for each stretch.

- A row's duration spans its **first to last observed event**. Time is never padded to the next
  event, so a single observation shows as "brief".
- Five minutes or more without events appears as **No recorded activity**; it is not counted as
  active or idle.
- Recorded markers get specific labels: **Display asleep**, **Screen locked**,
  **Private activity excluded**, and **Capture off or app not running** (a gap that ends when
  capture restarts).
- The tail of the previous day's file primes the privacy filter, so a protected browsing context
  that began before midnight stays hidden after midnight.
- Reads are bounded (48 MB, 60,000 events, 3,000 rows per day) and the view says when a day was
  truncated. Dates are validated and file paths are built only from a validated date.
- Idle time is **not** persisted. Live system idle time only suppresses reminders. The timeline
  distinguishes explicit sleep, lock, privacy and capture-restart markers, and says
  "No recorded activity" for everything else.

**Timeline → Summaries** keeps OpenHistory's model-written rollups for people who enable
summaries. **Chat** remains available and still requires a cloud model.

## Architecture

```text
Swift sampler (existing, 0.75 s) ──► JSONL activity files (unchanged format)
      │                                   │
      │ tagged evidence packet            ▼
      │ (only during a session)      Timeline → Activity (per-day reader)
      ▼
CollectorService (Node): validate + privacy ──► FocusController ◄── renderer IPC (zod-validated)
                                                   │   ▲
                         pure focus-state reducer ─┘   │ snooze / dismiss / hidden
                                                   ▼   │ (nudge + session IDs)
                                   FocusOverlay.swift: edge panel + reminder card
```

Data shapes (`src/shared/focus.ts`):

- `Goal { id, title, why, currentFocus }`,
  `FocusPreferences { domains, durationMinutes, experience: "amber" | "grayscale_window" |
  "grayscale_screen" | "grayscale_system", amberEdge }`.
  `focus.json` stays at version 1; a missing `experience` reads as `"amber"`, and a missing
  `amberEdge` as `true` only for the amber style.
- Every reminder request carries `amberEdge`. For `grayscale_system` the native overlay captures
  nothing; `SystemColorFilterController` (`src/main/system-color-filter.ts`) is the single,
  synchronous owner of `SystemColorFilterSettings { enabled, type }` through the native
  `SystemColorFilterBinding { read(), write(settings) }` (`systemColorFilterRead` /
  `systemColorFilterWrite`), and of the journal `{ baseline, applied }`. `FocusController` derives
  the wanted state from the visible reminder. The view reports
  `systemFilter { available, phase: "idle" | "applied" | "restore_failed" | "unsupported", failure, restorePending }`.
- A window-only reminder request also carries `domain`, the listed rule that matched, so the
  native side can confirm the focused window against later foreground evidence.
- The view also reports `screenCapture { access, requested }` separately from browser detection,
  and `effect { requested, status: preparing | showing | fallback, fallbackReason, visible }` for
  the latest reminder or preview. Native effect reports carry the nudge ID and are ignored unless
  that reminder is still visible.
- `FocusSession` is `idle` or `active { id, goal snapshot, intention, domains, startedAt, endsAt,
  snoozedUntil }`, kept in memory only.
- Foreground evidence is `browser { generation, sequence, observedAt, processIdentifier,
  bundleIdentifier, domain }` or `unknown { generation, sequence, observedAt, reason }`.

Key rules (`src/main/focus-state.ts`, pure and unit-tested):

- Each session gets a new observation **generation**; evidence from another generation, an older
  sequence, or more than 3 s old (or from the future) is ignored.
- A session never inherits evidence, cooldowns or reminder IDs from an earlier one, and it starts
  in "waiting" instead of being seeded from past events.
- Every reminder has a **nudge ID**. Native snooze and dismiss actions must match the current
  session ID and a known nudge ID, so a late click can't affect a newer session.
- Losing capability (pause, Accessibility revoked, URL capture off, protected context) hides a
  reminder immediately. Foreground changes also hide it immediately; only a preview has an 8 s timeout.

Native reminder (`native/bridge/FocusOverlay.swift`, in the existing dylib):

- Two `NSPanel`s, borderless and `.nonactivatingPanel`, with `canBecomeKey`/`canBecomeMain` false.
  `isFloatingPanel` is set **before** the level (setting it resets the level), then
  `statusBar` level, `canJoinAllSpaces` and `fullScreenAuxiliary`. Shown with
  `orderFrontRegardless`; the app is never activated and no window becomes key.
- The edge panel ignores the mouse and is hidden from Accessibility. It draws a 2.5 pt rounded
  amber perimeter with a soft inward shadow about 60 pt deep and a clear center.
- The card has native, VoiceOver-labeled buttons that work without making the panel key. Clicks
  on the card are excluded from pointer capture.
- Reduce Motion (no fade), Reduce Transparency (solid edge and card) and Increase Contrast
  (thicker edge, dark keyline, opaque card) are read at show time and update live.
- Before showing, the expected process must still be frontmost. A display disconnect hides the
  reminder immediately, a Space change fades it, and stale fade completions can't hide a newer
  reminder.

Build: `native/bridge/build.sh` uses SwiftPM's `native` build system (Swift 6.4 defaults to a
different output layout) and links **every** `ActivityCore` object, failing if the count doesn't
match the sources. Override with `OPENHISTORY_SWIFT_BUILD_SYSTEM` only if the layout matches.

## Tests and probes

```bash
npm test                          # typecheck, TS tests, inference preservation, Swift tests, distribution checks
npm run build                     # native bridge + Electron bundles
npm run test:native-bridge-smoke  # real C → Swift → C → Node callback contract (after npm run build)
sh scripts/sample-app-resources.sh "OpenHistory Focus" 120 > resources.csv
```

- `test:native-bridge-smoke` loads the built `.node` in plain Node, starts the collector in a
  temporary directory with every content category off, requests evidence, and checks that the
  tagged packet arrives through the callback, carries the requested generation, contains no site
  with URL capture off, and is never written to the activity file. It also checks that malformed
  reminder requests are rejected and that a reminder for a non-frontmost process is refused before
  any window is created. Only event kinds and reasons are printed.
- `sample-app-resources.sh` reads `ps` statistics only. Run it idle and during a session.
- `npm run test:grayscale-gpu` renders synthetic pixels through the production GPU renderer and
  checks grayscale and orientation. Window geometry (Retina crops, negative display origins,
  clipped and spanning windows, ambiguous matches) and the follow/retarget rules are pure Swift
  in `ActivityCore/FocusWindowTargeting.swift`, covered by `npm run test:native`.
- Manual check for Grayscale window (packaged app, Screen Recording granted): choose
  **Grayscale window**, press **Test reminder** and confirm only the Focus window turns gray.
  Drag it: the gray image should disappear while moving and return in place. During a session,
  open a listed site in one browser window and an unlisted site in another; only the listed
  window should turn gray, and switching to the other window should remove the gray image at
  once. Drag the listed window across two displays; the reminder should lose its grayscale with
  "the window is on more than one display".
- Manual check for System grayscale (packaged app, Screen Recording not granted): choose
  **System** and press **Test reminder**. Every display, the card and the edge should turn gray,
  then return to the earlier Color Filters settings about 8 s later. Repeat with a different
  filter already on; it should come back. Toggle **Amber edge** during a session reminder: the
  edge should appear or disappear without the session restarting. Quit while a reminder is gray:
  colors should return before the app exits.

Automated coverage includes domain anti-spoofing, malformed IPC and persistence, session expiry,
snooze, dismiss, cooldown, re-entry, stale and out-of-order evidence, stale native actions,
unknown evidence, stop, pause and restart, day reads well beyond 250 events, midnight privacy,
gap labels, truncation limits, path traversal and symlinked files.

## Known limits

- Only Safari and Chrome are targeted for verification. Other browsers are experimental.
- Address detection relies on the collector's existing Accessibility search (English labels, up
  to 300 nodes). Localized browser UIs may yield "unknown", which means no reminder.
- Returning within the 2 s cooldown waits until that interval ends. The glow stays visible while a listed site is active. Tab and window changes are detected by the existing 0.75 s sampler; app switches also dismiss via a native activation notification.
- Full-screen apps, multiple Spaces, multiple displays and physical keyboard focus behavior need
  manual verification per macOS version. The reminder panels are configured for them, but only
  verified configurations should be claimed.
- The shared-suffix list that blocks overly broad rules such as `co.uk` or `github.io` is short
  and hand-maintained (no public-suffix dependency).
- Grayscale screen: OpenHistory Focus's own reminder panels stay in color. The capture filter's
  window exceptions are taken when capture starts, so an OpenHistory Focus window opened while a
  grayscale reminder is already showing is hidden behind the gray image until the next reminder.
  A resolution change during a grayscale reminder switches it to the amber edge. Motion under the
  gray image is limited to 30 fps.
- Grayscale window has not been verified live on any browser or macOS version yet. While a window
  moves or resizes it stays in color, and after it stops the gray image returns once capture
  restarts. A window spanning two displays, a window whose Accessibility bounds don't match
  exactly one on-screen window (for example two windows stacked at the same bounds) use the
  amber edge. Switching to another listed site replaces the window reminder with that site's
  rule while preserving the session. Chrome-installed web
  apps are expected to work when their window belongs to the process Focus observes; otherwise
  they fall back to amber and site detection itself is unaffected. Window rules are
  compared as the matched listed site and its subdomains; an internationalized address that the
  browser reports in a different form than the rule falls back to amber.
- Grayscale is a captured image over a display or rectangular window area, not an OS color filter.
  Protected video may be blank, fast motion may lag, and overlapping content inside the window
  rectangle is also grayed. Popups extending outside that rectangle may remain in color.
- System grayscale relies on private, unsupported macOS calls that may stop working. It affects
  every display. A crash or force quit while it is on leaves the screen gray until the next
  launch restores the journal. Changing the amber edge replaces a visible reminder, which briefly
  restarts captured grayscale.
- Idle time is not recorded in the timeline; only live idle suppresses reminders.
- A day file written under a different time zone is shown under the date in its file name.
- Chat still requires a cloud model.

Validation evidence and untested configurations are recorded in [FOCUS-VALIDATION.md](FOCUS-VALIDATION.md).
