# Focus companion validation

Validation on 21 September 2026, macOS 26.6.2, Apple Silicon, one built-in display.
The fork includes upstream main at `daf7b073ce93673d0453d9f69b7435224c4bf49c`.

## Automated checks

- `npm test` passes 267 TypeScript tests, 30 Swift tests, inference-preservation checks for six model paths, and distribution checks.
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

- Browser detection depends on accessible HTTP(S) addresses. Safari and the other recognized browsers have not received the same live validation as Chrome. Private-window detection is heuristic, not a universal guarantee.
- App-switch dismissal uses a native activation notification. Same-app tab/window changes wait for the existing 0.75-second sampler; unresponsive accessibility APIs can delay it.
- Multiple displays, final-build fullscreen/Spaces behavior, physical keyboard delivery and OS-wide Reduce Motion/Transparency settings have not all been exercised on this machine. The native implementation handles those settings and uses nonactivating panels, but this is not a universal platform guarantee.
- Idle time suppresses reminders but is not stored as historical idle duration. Timeline spans are observed intervals; unknown gaps remain unknown.
- Hard blocking is outside this MVP. See [FOCUS.md](FOCUS.md) for the extension/enforcement work it would require.

## Independent review

Claude Opus reviewed privacy, native lifecycle, IPC and packaging. It found an overnight restart-state bug and a day-navigation response race, both fixed. GPT-5.6 Sol reproduced the short-cooldown dismissal race and a duplicate-callback edge; both now have regression coverage. Comment review preserved platform constraints and removed implementation narration.
