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
356 TypeScript tests, 42 Swift tests, native bridge smoke, distribution and inference-preservation
checks pass. Synthetic GPU checks still pass for grayscale orientation and scaling.
The signed app builds and launches with the existing permissions and saved preferences.

The new tests cover frozen countdowns past the original deadline, fresh observation after resume,
pause versus snooze, effect restoration, session edits, stale native actions, transient native-show
failures, snapshot deduplication, preference migration, tray ownership and display-position clamping.

Live checks confirmed the native capsule and running countdown, keyboard entry, Tab navigation,
pause through Space, overflow through Return, moving to menu-bar-only mode, restoring the floating
bar and editing remaining time without restarting the session. The bar has a full-height translucent
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
