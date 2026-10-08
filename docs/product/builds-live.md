# Builds and Live

## From a request to a game

Auto edits directly; Loop can delegate workers while the chat leads and reviews. In an Unreal
game, one lead builds in the editor, judging its own captures, helped by workers. Timed builds
use their window; until-satisfied ones finish on verified required outcomes, time a safety
ceiling. Acceptance persists across workers and restarts. External
blockers pause the run, keeping its checkpoint. User Finish overrides the clock, never the
final judge. [Harness runtime](../harness-runtime.md#goal-completion-and-worker-approvals)
owns completion and recovery details.

An active run opens Builds once; later choices are the user's, but a build shown
from the chat opens Live. Builds needs a plan or run; otherwise a stored Builds choice falls back to Live. A file or image opened from the chat adds its own tab until closed, with Show in Finder for game-folder files.

## The two views

**Live** plays the browser game in a native view (WebGL and WebGPU); hidden unobserved previews
pause. The strip holds Live/Builds/Assets, Play/Stop, Reload, the sound switch (⌥⌘M; only a shown
Live in front is heard), Full screen (hold Esc to leave) and plugin actions such as Publish (accent
until listed). Stop halts the game until Play or Reload. Slow loads show a halftone loader and
“Loading game”. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress while a run works, Play latest once a build is
ready; the first healthy build then shows itself. Otherwise only the user changes Live (opening a
game, Reload, Play, Make live, a chat request while hidden). A newer healthy build, a
changed game folder (checkpoint, landing, rewind), a chat's show or landing, or a shown build found
broken lights Reload (accent dot, tooltip), which brings it in. While Live is hidden and
not stopped, all but a new build go in at once. A loaded page alone is not a successful build. The
preview reaches only public library CDNs; Open Game names other hosts. An Unreal game's Live shows
its project and its next setup step; no web controls or Publish.

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. An eye marks nodes the reviewers looked at. A new build is “Checking it starts…” until
it has run. A working node shows its agent's screen and action (“Pressing Space · 3s”). A selected
node opens in place as a card without zooming; an eye opens it on the reviewers' notes. **Follow up in chat** turns the next message into a note to that node's build.
An earlier build opens from its chat card. An Unreal Loop's rows are the lead's milestones of saves
it kept (no eye), with worker nodes and critic advice.

Agents test in hidden windows, never in Live. Chat reuses
the lead's frames, which never certify a delivered build. Worker finished, checks passed,
integrated and shown in Live are distinct facts summaries never merge. Builds and Studio report
missing checks, coverage limits, counts and revisions.

## Continuation and interruption

After a chat-led night, its session takes follow-ups: editing the game, resuming a paused run
with its time left, starting over only when asked. With Loop on, a small change is made directly;
more work reopens the build until checked, or starts an Unreal game's next Loop. One the chat
cannot continue, like Ollama's, is answered as with Loop off, noting it once. **Stop** interrupts work immediately, preserving finished
work; a stopped Loop run shows one Stopped line with Resume, and Builds or a chat request makes its
build live. A crash or restart settles abandoned activity from persisted state; stopped, failed,
incomplete and delivered outcomes stay distinct.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) selects the stage;
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) manages Live/Builds/Assets.
- [run-steps](../../src/renderer/run-steps.ts) folds steps; [RunGraph](../../src/renderer/panels/RunGraph.tsx)
  and [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw them.
- [Conversation coordinator](../conversation-coordinator.md): queue, continuation and Stop.
- [Harness runtime](../harness-runtime.md): agent boundaries; [Unreal Loop](../plugins.md#mcp-servers).
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): run,
  preview and recovery contracts.
