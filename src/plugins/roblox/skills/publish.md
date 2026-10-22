# Publish to Roblox

Use this in the turn that answers "Roblox Studio asks: Publish …". That turn holds Genex's
computer control over Roblox Studio for this task only: it clicks Studio's own publish dialog,
because no Studio or plugin API publishes a place and Genex never asks for Roblox API keys. The
person asked for this publish (they pressed Publish, or approved a card); don't ask them again.
This turn does the clicking itself with the desktop tool: never call `first-publish`,
`publish-update` or `do-it-for-me` here. The person watches a publishing card while you work: end
the turn with `publish-result` (below), so the card shows how it ended.

## Rules

- **Only what the task says.** Publish this game's place, under the name the task gives for a
  first publish, and give it its cover (below). Never change privacy (a new game stays as private as Studio makes it), never make
  the game public, never touch Robux, prices, game passes, ads or age settings, never buy anything
  and never open the Roblox player.
- **Keep Studio's own choices.** Leave the creator, genre, devices and every other setting as
  Studio fills them in; leave the description empty.
- **Stop for the person** and click nothing more when Roblox or Studio shows anything that is
  theirs: an age check, an ID check, a two-step or verification code, terms to accept, a payment,
  a sign-in, a question about saving, or any dialog you don't recognise. Say exactly what it asks
  and where (and in `publish-result`); they answer it, then ask again.
- **Studio's own state is yours to handle, never the person's chore.** Genex ends a play test and
  brings Studio back to its editor before handing you the publish. Read Studio's mode only from the
  Roblox Studio connection's `get_studio_state` ("Current Studio Mode: Edit" is editing): a
  NetworkClient in Explorer (a place edited from Roblox has one while editing) and the Test tab's red
  Stop button don't mean a test runs. If a test really runs, end it with `start_stop_play`
  (`is_start: false`) and go on. Wait while Studio opens or reloads the place (its window title
  names the place once it is ready), and close what Studio itself puts in the way: a tip, a "what's
  new" note, the Start Page, a panel over the menu bar.
- **Real pointer clicks with Studio in front.** Studio's menus report their items as disabled to
  accessibility and its dialogs have no accessibility actions: bring the window of this game's
  place to the front (its title names the place), then click with the pointer and type into the
  focused field. Look at the screen after each step.

## A first publish (a new game)

1. In Studio's menu bar, click **File**, then **Publish to Roblox**.
2. If the dialog asks where to publish, choose to **create a new experience** (never an existing
   one: that would overwrite another game).
3. In **Name**, replace whatever is there with the exact name the task gives.
4. Leave **Description** empty and every other field as it is.
5. Click **Create** (or **Publish**). Wait until the dialog closes and Studio's window title shows
   the new name.
6. Call `publish-result` with `published: true`, then say in one line that it is published under
   that name. Genex links this game to the published place by itself; don't press anything in
   Genex's panel for it.
7. Give the game its cover (below).

## An update

1. In Studio's menu bar, click **File**, then **Publish to Roblox**.
2. If Studio asks to confirm, confirm the publish; anything else is a stop (rules above).
3. Wait until Studio says it has published, call `publish-result` with `published: true`, then say
   so in one line.
4. If **Game Settings › Basic Info** shows Roblox's default picture as the game icon, give the game
   its cover (below); leave a cover it already has.

## The game's cover

Roblox shows a grey placeholder until a game has its own icon and thumbnail, and Studio's publish
sets neither. Only Studio's Game Settings take them (no API does without the person's keys).

1. Frame Studio's viewport on the game's most telling view: move Studio's camera there (a short
   script setting `workspace.CurrentCamera.CFrame` through the Roblox Studio connection), with
   nothing selected and no panel over the view. The picture must show the game's world (its map,
   its rooms, its players' space), never only sky or an empty baseplate.
2. Call `cover-pictures`. Look at the icon and the thumbnail it answers; if they don't show the game
   well, frame a better view and call it again.
3. In Studio, open **Home › Game Settings**, then **Basic Info**.
4. Under **Game Icon**, upload the icon; under **Thumbnails**, add the thumbnail. In the file dialog,
   go straight to the path the answer gave (⌘⇧G on a Mac, the file name field on Windows), paste it
   and press Return, then open it.
5. Click **Save**, and say in one line that the cover is set (Roblox reviews new pictures before it
   shows them). If Studio refuses a picture or asks anything else, stop (rules above) and say what it
   showed; the game stays published either way.

## If it fails or stops

Call `publish-result` with `published: false` and a `detail` naming what Studio or Roblox showed (in
its own words) and what the person answers there; say the same in the chat, and stop. Never retry with another menu, a shortcut you
haven't seen work, or another Studio window.
