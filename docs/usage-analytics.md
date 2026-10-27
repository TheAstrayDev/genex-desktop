# Usage analytics

Opt-in PostHog events, screens and, for a sample of new installs, replays — so the team can see
where people get stuck without seeing what anyone builds. [PRIVACY](../PRIVACY.md#analytics-and-shared-build-metrics)
says the same for the person; the [feature map](agent/feature-map.md) lists the selectors.

## Which builds and launches

A build made with `STUDIO_POSTHOG_KEY` (optional `STUDIO_POSTHOG_HOST`, default
`https://eu.i.posthog.com`) carries analytics; without it nothing changes: no key, no CSP entry,
no question, no Privacy row. [`src/shared/analytics.ts`](../src/shared/analytics.ts) reads the key
in `scripts/build.mjs`, refuses a non-https host or a PostHog host that takes no events, defines
`__STUDIO_ANALYTICS__` for main and adds only PostHog's ingest and asset origins to the built
page's `connect-src`; `script-src` stays `'self'`. Main offers it only to a launch that may send
(`launchSends` in `main/run-sharing.ts`: packaged, no `--studio-*` switch, no owned profile, no
test data); the bootstrap carries the config (`Bootstrap.analytics`).

To test the integration, point `STUDIO_POSTHOG_KEY` at a test project and set
`STUDIO_ANALYTICS=1` both when building (a developer build then keeps the key) and when
launching (an owned or unpackaged launch then offers it). Never use the release project's key.

## Asking

The renderer asks once per profile and consent version (`studio.analytics`, `{choice, version}`;
`ANALYTICS_CONSENT_VERSION` in `renderer/analytics/consent.ts`): raise the version when what is
collected grows, and every profile is asked again. `panels/AnalyticsConsent.tsx` sits above the
first launch's welcome, whose film holds on the caret until the answer, or above home at the first
launch of a version with analytics; the Genex promo and the avatar welcome wait for it. Both
answers weigh the same and neither can be dismissed. Settings → Privacy's **Share usage data**
changes the answer. Only a yes is sent (`analytics_turned_on`).

## Replays

`replayDraw` draws once, at the first launch that offers analytics: one first launch in five
(`REPLAY_SHARE`) records a replay for `REPLAY_WINDOW_MS` (a week); a profile welcomed before never
does. Only a sampled install sees the replay line in the question and in Settings. Recording is
off in PostHog's options and started by the app (`startSessionRecording(true)`, past the
project's own sampling).

## What leaves

Only after a yes does [`renderer/analytics/client.ts`](../src/renderer/analytics/client.ts) import
the bundled `posthog-js/full/no-external` chunk; no script is ever fetched. Until it is up,
events wait in memory (at most `EARLY_EVENTS_MAX`) and leave with their own time; a no drops them,
stops recording, opts out and resets the id.

- **Screens**: `$pageview` per screen from the app's vocabularies (`renderer/analytics/screens.ts`:
  `/welcome/<step>`, `/home`, `/game/<view>`, `/harness`, `/plugins`, `/items`, `/play/<page>`,
  `/settings/<section>`, `/search`, `/open-folder`, `/feedback`). The page hash names the screen
  and every URL becomes it under `https://studio.invalid`.
- **Clicks**: autocapture without text or attributes, rage and dead clicks, heatmaps.
- **Product events**: one vocabulary per part of the app in `renderer/analytics/events/`
  (`launch`, `welcome`, `workspace`, `chat`, `builds`, `plugins`), with that part's pure
  builders beside it (`renderer/analytics/<part>-*.ts`), sent with `track`, whose properties are
  enums, switches, counts, size buckets and durations only (`renderer/analytics/properties.ts`).
  Facts main already announces come from `renderer/analytics/observers.ts`: each log record once
  (the newest counted is kept in `studio.analytics.logSeen`), and main's UI events through the
  stores' own subscription (`studio.onUiEvent`). `track`, the super-properties and every listener
  run guarded: analytics failing never reaches the app.
- **The welcome** keeps the step an unfinished welcome stood on (`studio.analytics.welcomeScreen`),
  so the next launch's `welcome_shown` says it resumed and where.
- **Every event** carries app version, platform, language, a per-launch id, first launch, the
  ready engines and whether a Genex account is signed in. There is no `identify()`: the id is
  random and kept in the renderer's storage.

Never sent: prompts, chats, answers, plans, tool inputs, game, folder, chat, account or
plugin-author names, paths, URLs, models a person typed, server hosts, ids of theirs or English
error text. A game appears only as a random local id (`studio.analytics.games`).

## Replays show the app, not the work

`renderer/analytics/masking.ts`: text shows only on the app's own controls outside content
regions, and never when it looks like a path. Content regions are the chat transcript, user
messages, streaming replies, questions, plans, file links (`[data-file-path]`) and anything
marked `data-analytics-mask`. A component that shows a person's work or a name they chose
inside a control marks its wrapper `data-analytics-mask`; pictures `data-analytics-block`; an
app heading outside a control may opt in with `data-analytics-visible`. Pictures, canvases,
frames, terminals and the file viewer are blocked and input is masked. `before_send` rewrites any
`file://` address or home folder left in events and replay batches. In the PostHog project, turn
on "Discard client IP data".

## Release and verification

`release.yml` passes the repository variable `STUDIO_POSTHOG_KEY` to the packaging steps; unset,
releases carry no analytics. `tests/conformance/analytics.test.ts` covers the build and launch
gates, the CSP, the answer and the replay draw, screens, masking, the last pass and a yes or no
while the chunk loads; `analytics-<area>.test.ts` cover each part's events;
`renderer-state.test.ts` covers asking once per version and the replay draw. A build with a key
shows the extra `connect-src` origins in `dist/renderer/index.html`.
