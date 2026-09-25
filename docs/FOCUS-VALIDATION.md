# Focus companion validation

Validation on 21 September 2026, macOS 26.6.2, Apple Silicon, one built-in display.
The fork includes upstream main at `daf7b073ce93673d0453d9f69b7435224c4bf49c`.

## Automated checks

- `npm test` passes 293 TypeScript tests, 38 Swift tests, inference-preservation checks for six model paths, and distribution checks.
- Real N-API smoke verifies collector callbacks, generation-tagged foreground evidence, malformed request rejection, callback cleanup, and no evidence persistence. The command-line test identity lacks Accessibility, so this is not a browser-permission test.
- Host Electron/native packaging succeeds. The local build is signed with the developer's installed Apple Development identity and passes strict signature verification. It is not notarized or a Developer ID release.
- The public-repository check and `git diff --check` pass. No activity files, local credentials, dependency symlinks or internal review scratch files are included.

Regression coverage includes exact host/subdomain matching, protected contexts, stale and reordered evidence, session changes, idle suppression, the requested two-second cooldown, persistent reminders, immediate hide effects, duplicate native dismissal callbacks, live site additions/removals without resetting the timer or bypassing snooze, snooze, dismiss, goal persistence, owned-root deletion, timeline days beyond 250 events, overlapping lock/sleep, midnight and collector restarts.

## Observed behavior

- Local-only onboarding completed without an API key. Optional mail/chat and rich content capture stayed off.
- Goal creation, site configuration and starting a session were exercised in the standalone app. The user confirmed both the amber perimeter and floating reminder appeared for YouTube in Chrome, then confirmed the requested two-second/persistent behavior in Chrome and the YouTube PWA.
- Synthetic timeline data with more than 250 records rendered. Goal/site preferences and paused capture persisted after restart; the session did not restart automatically.
- CLI-launched Electron had a different macOS permission responsibility from the standalone package. Later macOS logs exposed a stale ad-hoc code requirement and an unresolvable temporary app location. Installing the development-signed bundle in `/Applications`, registering it, and resetting only its stale Accessibility grant resolved the loop. System Settings now lists **OpenHistory Focus.app** enabled, and the installed app reports ready with a new reminder timestamp.
- A separate Chrome-installed YouTube app exposed a browser-recognition gap. Recognition now uses its exact Chrome app bundle shape and the existing readable-URL/privacy path. The user confirmed the installed build works both in regular Chrome and the standalone YouTube PWA, including persistent glow and disappearance on switching apps.

The earlier native prototype verified snooze dismissal, non-key/non-main panels and visibility over a fullscreen Electron window. Those observations are prototype evidence, not a claim that every fullscreen app or Space configuration works.

## Resource observations

An interactive 60-second interval in the first standalone build averaged 26.91% summed app-process CPU and peaked at 207.2 MB RSS. A later 25-second low-activity observation averaged 2.02% CPU. These are rolling `ps` estimates, not battery measurements or controlled benchmarks. Profiling found an unnecessary browser-address tree scan on nonbrowser apps. The final collector skips that scan; the size of the improvement is unmeasured. A later 60-second installed-build session sample averaged 3.54% CPU, peaked at 46.5% CPU and 328.9 MB RSS. The foreground workload was uncontrolled, so these samples do not establish a causal speedup.

## Remaining limits

- Grayscale screen: 286 TypeScript tests, 30 Swift tests, native bridge smoke,
  distribution checks and the signed host package passed. `npm run test:grayscale-gpu` renders
  synthetic color quadrants through the production GPU renderer and verifies grayscale,
  orientation and scaling at two sizes without screen access. The installed app preserves goals
  and sites and correctly reports amber fallback when Screen Recording is denied. Live capture,
  first-frame presentation, revocation and resource use still need permission-enabled validation.
- Grayscale window: reducer, controller, persistence and pure Swift geometry/retargeting tests
  pass, along with the native bridge build and synthetic GPU checks. The final signed package
  launches with all three styles. Window preview reports permission fallback correctly, and a
  live session retains its end time when switching to screen mode; the test session was stopped.
  No permission-enabled capture verification has been done: window matching,
  cropped capture, following moves and resizes, same-browser window switches, multiple displays,
  Chrome-installed web apps and Safari all still need permission-enabled manual validation.
- Browser detection depends on accessible HTTP(S) addresses. Safari and the other recognized browsers have not received the same live validation as Chrome. Private-window detection is heuristic, not a universal guarantee.
- App-switch dismissal uses a native activation notification. Same-app tab/window changes wait for the existing 0.75-second sampler; unresponsive accessibility APIs can delay it.
- Multiple displays, final-build fullscreen/Spaces behavior, physical keyboard delivery and OS-wide Reduce Motion/Transparency settings have not all been exercised on this machine. The native implementation handles those settings and uses nonactivating panels, but this is not a universal platform guarantee.
- Idle time suppresses reminders but is not stored as historical idle duration. Timeline spans are observed intervals; unknown gaps remain unknown.
- Hard blocking is outside this MVP. See [FOCUS.md](FOCUS.md) for the extension/enforcement work it would require.

## System grayscale and independent amber edge

Validated on macOS 26.6.2 arm64 with the signed installed application.

- Private API read/write (enabled and type, toggled on and off, then restored to the original
  settings) was verified directly on macOS 26.6.2 arm64 with an on-screen check. That check
  covers the native calls. The installed app also activated a System preview and showed
  its completed status afterward; System Settings confirmed Color Filters returned to Off.
  A YouTube session triggered a reminder. Live app-switch timing remains a manual check.
- All 323 TypeScript tests passed, including seven restoration regressions. Typechecking,
  the host signed package, native bridge smoke and 4×4/8×8 GPU orientation tests passed.
- Automated coverage: legacy preference migration (edge stays on only for the old amber style),
  every grayscale/edge combination in the reminder request, live edge and style changes that
  keep the session, system grayscale without Screen Recording, the journal written before the
  first write, exact restore of earlier enabled/type settings, already-grayscale settings left
  untouched, a manual change kept, failed and half-applied writes, a restore failure that keeps
  the journal and blocks turn-ons, launch recovery (including an unreadable journal), and
  hide/snooze/stop/shutdown/restore paths.
- The native bridge smoke reads (never writes) Color Filters and accepts a `grayscale_system`
  request without starting capture.
- Needs manual validation in the packaged app: multiple-display behavior, the edge toggle during a reminder, **Restore previous colors**, quit while
  gray, and a relaunch after a forced quit while gray. Also confirm the edge draws above captured
  grayscale and below the card, and never appears in the gray image.

## Independent review

Claude Opus reviewed privacy, native lifecycle, IPC and packaging. It found an overnight restart-state bug and a day-navigation response race, both fixed. GPT-5.6 Sol reproduced the short-cooldown dismissal race and a duplicate-callback edge; both now have regression coverage. Comment review preserved platform constraints and removed implementation narration.

Grayscale review fixed a shared mutable filter race, first-frame completion handling, vertical image orientation, stale site-edit preferences, and sampled-window identity during same-browser switches. Switching between different listed sites now replaces the window reminder without resetting the session.

## Grayscale orientation regression

A live user report exposed a vertical inversion that the original raw-texture test missed.
The renderer manually flipped the CIImage even though its non-flipped AppKit CAMetalLayer
presents texture row zero at the bottom. Removing that transform restores the displayed image.
A native synthetic window using the production renderer and actual drawable was observed via
computer-use screenshots before and after the fix: the old image swapped the top and bottom
quadrants, and the corrected image matches the color reference. The updated GPU test maps rows
through that presentation convention, fails against the old renderer, and passes at 4×4 and
8×8 with the fix. Both grayscale modes share this renderer.

Build the visual regression fixture with `sh scripts/build-focus-grayscale-presentation-fixture.sh`
and open the printed app path. Its four displayed grayscale quadrants should match the source
positions; it needs no Screen Recording permission. This is presentation-path evidence, not a
claim that every live crop/display configuration has been validated. During automated app
preview testing, window targeting fell back to amber, so live browser crop alignment remains
separate from this confirmed orientation fix. The user has now enabled Screen Recording.

## Webmail focus detection

Webmail host detection now uses a Focus-specific verdict. Email recording remains controlled by
its existing opt-in. Before the fix, the new TypeScript host and collector-service regressions
failed because Gmail evidence was downgraded to unknown. After the fix, all 327 TypeScript tests
and 35 Swift tests pass. Coverage includes Gmail reaching Focus while its activity event and
recent-event buffer stay filtered, private Gmail producing no host, Browser URLs off suppressing
evidence, retained messaging/adult exclusions, and listed webmail matching a reminder rule.
Typechecking, native bridge smoke, distribution checks, and the signed Apple Silicon package pass.

The updated installed app launches with the existing permissions and preferences. Its active
focus session was resumed with approximately the previous remaining duration. The live Gmail
browser check was inconclusive because computer control was interrupted and then timed out.
No inbox screenshot or email text was collected for validation. Live Gmail presentation remains
a manual verification item; automated checks cover the native policy, TypeScript boundary and
reminder state machine, not the full browser Accessibility pipeline.

## Floating Focus bar, pause and the session menu bar

Validated on 23 September 2026 on macOS 26.6.2, Apple Silicon. Typechecking,
357 TypeScript tests, 42 Swift tests, native bridge smoke, distribution and inference-preservation
checks pass. Synthetic GPU checks still pass for grayscale orientation and scaling.
The signed app builds and launches with the existing permissions and saved preferences.

The new tests cover frozen countdowns past the original deadline, fresh observation after resume,
pause versus snooze, effect restoration, session edits, stale native actions, transient native-show
failures, snapshot deduplication, preference migration, tray ownership and display-position clamping.

Live checks confirmed the native capsule and running countdown, keyboard entry, Tab navigation,
pause through Space, overflow through Return, moving to menu-bar-only mode, restoring the floating
bar and editing remaining time without restarting the session. Green progress fill was checked at a visible fraction, and its paused variant was checked on screen. A resume rounding error was reproduced in a test and fixed by preserving milliseconds in native snapshots. The bar has a full-height translucent
progress fill behind its labels and controls. Progress is derived from the same elapsed-session model
and freezes while paused. A dark-mode contrast issue in the session editor was corrected after visual
inspection.

The user reported both amber glow and reminder card missing in the previous build and confirmed that
restarting restored them. Source review found no confirmed cause. Existing fade completions are
protected against superseding presentations. Preview requests succeeded, but window-only computer-use
screenshots do not prove that a full-desktop overlay was visible. Do not treat this intermittent issue
as fixed. If it recurs, inspect the Focus readiness/foreground status and whether Test reminder appears
before restarting, to distinguish missing browser evidence from native presentation.

Remaining live checks include dragging and restoring position across physical displays, fullscreen
and Spaces, complete VoiceOver navigation, prolonged resource profiling, precise keyboard return on
Escape, and combined grayscale/amber visual behavior. Automated geometry and exclusion tests are not
substitutes for those platform checks. Computer control was intermittently interrupted by concurrent
user interaction, so only the successful interactions above are claimed.


## Smooth progress and resizable width

Validated on 23 September 2026. Typechecking, all 359 TypeScript tests, all 46 Swift tests,
native bridge smoke, distribution checks and inference-preservation checks pass. The Apple Silicon
app builds with the existing development identity and passes strict deep signature verification.

A temporary native fixture compiled the production FocusBar implementation and sampled its actual
Core Animation presentation layer. The old implementation failed subsecond progression and resize
fraction checks. The updated fill advanced through 119.465, 124.307, 129.133 and 133.969 points between
one-second countdown ticks. Pause froze the fill and removed its animation. Updating width preserved
the elapsed fraction. An in-process Reduce Motion override removed animation and stepped on the next
tick without changing macOS settings. Hide removed animation and invalidated the paint timer.

Installed-app checks confirmed Fit Display Width at 1,728 points, Reset Width at 460 points, and full
width restoration after quitting, relaunching and starting another session. Dragging the right edge
reduced width to 1,328 points; dragging the left edge reduced it to 1,228 while saving x=100. Both
retained the 54-point height. Initial automated drags exposed global pointer sampling in the handler;
using each event's screen-converted location fixed the same gestures. A separate geometry regression
failed before correcting opposite-edge movement at display boundaries, then passed.

The app is left running with compact width and approximately the prior 6:38 PM session end time.
Physical multi-display transitions, fullscreen/Spaces and exhaustive cursor behavior remain untested.
The intermittent missing amber edge/card report above remains unresolved.

## Persistent menu-region timer bar

Validated on 23 September 2026, macOS 26.6.2, Apple Silicon. The timer bar uses the existing
Focus session clock and heartbeat. It adds no screen capture, private API or permission request.
A separate preference controls it independently of the floating bar.

Automated checks cover running and paused checkpoints, expiry while closed, restored deadlines,
clock rollback, fractional seconds, edits beyond 24 hours, malformed-file recovery, strict write
validation and failed-write behavior. Semantic actions save their checkpoint before changing the
live session. Normal quit retains the clock while removing overlays and restoring system colors;
explicit completion and data deletion clear it. Unchanged ticks do not rewrite the file.

A native fixture sampled the production mask between heartbeat ticks: its rendered width shrank
through 1281.91, 1263.85, 1245.81 and 1227.38 points. Pause held exactly 0.7075 of the width with no
animation. Reduce Motion held between heartbeats and stepped on the next update. An injected stale
fraction of 0.9 recovered to 0.610443 against a deadline-derived expectation of 0.610442. Repeating an
aligned request preserved its running animation. Enabled-idle retention, disabled cleanup and
shutdown cleanup passed, with no native timer owned by the controller.

The connected notched display reported a 1728×1117-point frame, a 33-point reserved menu region and
2× backing scale. The panel used `(0, 1084, 1728, 33)`, exact status-bar level, no shadow,
click-through/non-key flags and the requested Space/fullscreen collection flags. Foreground and key
window identity stayed unchanged during the native test. These checks validate panel configuration;
they do not prove visual ordering in every desktop configuration.

The repository's runnable fixture (`npm run fixture:timer-bar`) also passes. It waits for compositor
updates before sampling pause and Reduce Motion, rather than treating an immediate stale presentation
layer as a failure. Pure placement tests cover differing display heights, negative coordinates,
notch insets, scale independence and the 3-point fallback when a display reserves no menu region.

Physical external-display reconnects, cross-display synchronization, Stage Manager, light/dark menu
readability, actual sleep/wake and the full supported-macOS matrix remain manual validation items.
System grayscale intentionally desaturates this timer bar along with the rest of the desktop.

The final automated pass includes typechecking, 383 TypeScript tests, 55 Swift tests, native bridge
smoke, distribution, inference-preservation and grayscale GPU orientation checks. The development-
signed Apple Silicon package passes strict deep signature verification.

Installed-app checks confirmed the preference toggle, timer-bar-only presentation, and completion
removing the on-screen panel and clearing the saved session. Quit removed every app panel. Relaunch
preserved a paused remainder of exactly 8,194,766 ms, and a separate running restart preserved the
exact session ID, deadline and total duration. The app's normal desktop panel was 1728×33 points at
window level 25. In the app's own full-screen Space, WindowServer reported a 1728×3-point timer panel
on screen; returning to the desktop restored the 33-point menu region. WindowServer membership does
not establish visual ordering above every other app or prove per-display auto-hide behavior.

The app is left with Show timer bar enabled, the original floating-bar preference restored, and a
session ending at approximately the prior 6:38 PM target. The old build had no persisted clock, so
that one development upgrade required restarting the session; subsequent restart checks used the
new persisted clock without adjustment. The amber/card issue recorded earlier remains unresolved.

## Shared progress color

The Color row in Focus → While a session runs offers six presets and a native custom picker.
One lowercase hex preference controls both fills, including while paused. The floating fill keeps
0.24 opacity; the menu-region gradient uses 0.20 and 0.14. The amber reminder is unchanged.
Picker updates use one request in flight and retain the latest pending selection.

The native presentation fixture verified actual RGB values on both surfaces, live recoloring
without changing clock fields or animation signatures, continued movement between ticks, frozen
paused widths, invalid-input rejection, and unchanged foreground/key windows. Tests used one
connected display. The full automated pass includes 387 TypeScript tests, 61 Swift tests,
typechecking, native bridge smoke, the timer-bar presentation fixture, distribution and public
repository checks. Physical multi-display and platform coverage limitations above still apply.

Installed-app checks passed for the Blue preset, a custom RGB selection (`#7884b8`), and restoration
of that custom color after quitting and relaunching. The persisted session ID, deadline and total
were unchanged by installation, color changes and restart. Escape canceled the picker selection;
Return committed it. The original Green preset was restored after testing. The compact swatches,
selection ring/check, custom control and copy were inspected in the installed dark-mode window.

## Floating-bar height and corner resizing

Top and bottom edges resize height; corners resize both dimensions. The opposite edges remain
anchored. Height defaults to 54 points and can shrink to 40 points while retaining readable labels
and 28-point controls. Saved geometry includes height, and older documents migrate to 54 points.
Reset Height restores 54 without changing the requested width. Display clipping does not replace
the saved size of an untouched axis, including straight-axis corner drags.

Typechecking, 387 TypeScript tests, 69 Swift tests, native release compilation, native bridge
smoke, distribution checks, public-repository checks, Electron build and signed packaging passed.
A native presentation fixture using the production views measured 40- and 120-point panels,
content and fills. Controls fit and remain hittable; all eight edge/corner hit regions select the
correct handle. Running progress continues, paused progress remains frozen, and foreground and
key windows do not change. The fixture also drove production mouseDown, two mouseDragged events,
and mouseUp for all eight handles: top height 120→150, bottom 120→90, top-left 460×120→424×150,
and bottom-right 460×120→496×90. Opposite edges stayed anchored. Each gesture emitted exactly
one complete resized callback on release; post-release drag events did nothing. These are local
synthetic events, not physical desktop input or WindowServer routing.

Installed on macOS 26.6.2 with the existing signing identity. A 40-point height survived quit and
relaunch. Reset Height returned to 54, preserving the 360-point width. The exact session object
(including deadline and duration) stayed unchanged, and original geometry was restored. Desktop
automation could read and activate the panel's controls but failed coordinate drags with
`windowNotFoundAtPosition`, so this run does not claim verified physical top/bottom/corner drags.
Other macOS versions and physical display transitions remain unverified.


## Focus halo and edge colors — 24 September 2026

Validated on macOS 26.6.2 arm64 with one built-in display.

- Typechecking, 413 TypeScript tests, 69 Swift tests, six-path inference preservation,
  distribution/public-repository checks, native bridge smoke, the existing grayscale GPU fixture,
  Electron/native release builds and strict development-signature verification pass.
- `npm run fixture:focus-edge` builds a standalone app in the temporary directory. Run
  `"${TMPDIR:-/tmp}/FocusEdgePresentationFixture.app/Contents/MacOS/FocusEdgePresentationFixture"`
  to exercise the real production edge and reminder panels. It passed **233 assertions**:
  original amber pixels, all six presets/custom colors, transparent center/inward glow,
  live recolor, reminder registration across off/on, nonactivating/click-through flags,
  foreground/Space/wake invalidation, ordered observation recovery, stale fades and cleanup.
  It uses capture shims and local bitmap readback, not screen capture or macOS settings changes.
- A reproduced stale-token bug was fixed: after native context invalidation, only a
  lexicographically newer generation/sequence can restore the halo. Older observations and
  notifications cannot lower the watermark. Off releases edge panels and notification observers.
- Controller coverage verifies that a listed site hides the halo even during snooze/dismiss/
  cooldown, previews suppress it, mode/color edits leave card/capture/session clocks untouched,
  and a failed system-color restoration keeps the halo hidden until a successful retry.
- Preferences migrate from the old amber switch without losing goals/sites/session/geometry.
  Sync derives the edge color from the progress color and preserves the independent edge color.

Installed-app checks verified migration preserved goals, sites, geometry and the existing
System grayscale choice. Preset selection, the custom picker, sync on/off, progress-color
following and independent-color restoration worked; the edge mode, custom color and sync
preference persisted through restart. WindowServer reported the full-display
edge panel above normal windows during a running session. Completion removed the session;
the validation session was stopped. Desktop automation could not keep the YouTube test tab
foreground while the desktop was in use, so the full installed distraction/grayscale handoff
awaits user confirmation; controller and native lifecycle coverage above is automated evidence.

Physical multiple-display reconnects, mixed scaling, Stage Manager, fullscreen applications,
other macOS releases and actual sleep/wake remain manual validation items. Fixture notification
and window-flag checks do not establish visibility in every WindowServer configuration.


## Displaced timer bar recovery, 25 September 2026

The installed app reproduced a 1728-by-33-point timer panel at WindowServer Y=832 instead of
Y=0. The halo was a separate full-display panel at Y=0. Turning off Show timer bar removed the
interior strip without removing the halo; turning it back on placed the timer at Y=0. The cause
of the initial relocation is unknown. The confirmed persistence bug was a comparison against
cached requested geometry that ignored the actual window frame.

`npm run fixture:timer-bar` now displaces an existing native panel and sends the same clock
request again. Before the fix, `an identical request restores the panel to the top edge` failed.
After comparing the live panel frame too, the full fixture passes and verifies the same panel,
countdown view and deadline remain in use. The existing active-session heartbeat and environment
notifications perform recovery; no new timer or screen-capture path was added.
