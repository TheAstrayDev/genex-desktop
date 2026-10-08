import { useEffect, useId, useState } from "react";
import type { LoopSetting } from "../loop-setting.ts";
import { DONT_WAIT_WORDS, UNREAL_WORDS } from "../words.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { PickerCaption, PickerSegmented, PickerSeparator, PickerSwitch, pickerItem } from "./PickerPanel.tsx";
import { Icon } from "./icons.tsx";
import {
  formatDuration,
  MAX_LOOP_MINUTES,
  MIN_LOOP_MINUTES,
  MINUTES_PER_HOUR,
  parseDuration,
  shortDuration,
} from "./loop-duration.ts";

const PRESETS = [0.5, 1, 2];
const STEP_MINUTES = 15;
/** Custom opens on this many hours when no limit was set. */
const CUSTOM_START = 3;

/** The Loop control's segments besides the presets (whose value is their hours). */
const LoopChoice = {
  Off: "off",
  UntilSatisfied: "inf",
  Custom: "custom",
} as const;
type Choice = (typeof LoopChoice)[keyof typeof LoopChoice] | `${number}`;

/** The segment the Loop control shows: off, until it passes, a preset, or custom. */
function loopChoice(loopOn: boolean, hours: number | null, custom: boolean): Choice {
  if (!loopOn) return LoopChoice.Off;
  if (hours === null) return LoopChoice.UntilSatisfied;
  return custom || !PRESETS.includes(hours) ? LoopChoice.Custom : `${hours}`;
}

/** The Loop a pick sets, from the one it replaces: Off keeps the saved time, Custom starts from it. */
function chosenLoop(next: Choice, current: LoopSetting): LoopSetting {
  if (next === LoopChoice.Off) return { ...current, on: false };
  if (next === LoopChoice.UntilSatisfied) return { on: true, hours: null };
  // Custom starts from the current time limit, so fine-tuning a preset is one click away.
  if (next === LoopChoice.Custom) return { on: true, hours: current.hours ?? CUSTOM_START };
  return { on: true, hours: Number(next) };
}

/**
 * What the menu says about the Loop: its state, its caption, and the trigger's label with the
 * compact time limit before it. Off, the trigger says Auto; on, it says ∞ Loop or, say, 2h Loop.
 * Loop allows a build and never orders one: the agent makes a small change itself.
 */
function loopWords(loopOn: boolean, minutes: number | null) {
  if (!loopOn) return { state: "Off", caption: "Each message runs one turn.", label: "Auto", time: null };
  if (minutes === null)
    return {
      state: "Until it passes",
      caption:
        "Small changes are made right away. When a message needs a build, it plans, builds and reviews until the build passes.",
      label: "Loop",
      time: null,
    };
  const limit = formatDuration(minutes);
  return {
    state: limit,
    caption: `Small changes are made right away. When a message needs a build, it builds for up to ${limit}.`,
    label: "Loop",
    time: shortDuration(minutes),
  };
}

/** The custom limit's stepper: fifteen minutes either way, or a time typed in. */
function CustomLimit({
  minutes,
  draft,
  onDraft,
  onCommit,
  onMinutes,
}: {
  minutes: number;
  draft: string | null;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onMinutes: (minutes: number) => void;
}) {
  return (
    <div className="picker-stepper picker-expand">
      <button
        type="button"
        aria-label="15 minutes less"
        disabled={minutes <= MIN_LOOP_MINUTES}
        onClick={() => onMinutes(minutes - STEP_MINUTES)}
      >
        <Icon name="minus" />
      </button>
      <input
        type="text"
        aria-label="Custom time limit"
        value={draft ?? formatDuration(minutes)}
        spellCheck={false}
        onChange={(event) => onDraft(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
        }}
      />
      <button
        type="button"
        aria-label="15 minutes more"
        disabled={minutes >= MAX_LOOP_MINUTES}
        onClick={() => onMinutes(minutes + STEP_MINUTES)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

/** The Loop's segments: Off, ∞, the presets and Custom. While the game can't run a Loop, only Off can be picked. */
function loopOptions(unavailable: boolean) {
  const loop = { disabled: unavailable };
  return [
    { value: LoopChoice.Off, label: "Off" },
    {
      value: LoopChoice.UntilSatisfied,
      // The prompt bar's own ∞, which mono would draw flat; the hidden ∞ is its text.
      label: (
        <>
          <Icon name="infinity" />
          <span className="sr-only">∞</span>
        </>
      ),
      title: "Until the build passes",
      ...loop,
    },
    { value: "0.5" as const, label: "30 m", ...loop },
    { value: "1" as const, label: "1 h", ...loop },
    { value: "2" as const, label: "2 h", ...loop },
    { value: LoopChoice.Custom, label: "Custom", ...loop },
  ];
}

/**
 * "Don't wait for me" while the Loop is on: the chat's setting, read each time the menu opens, for
 * the run going now or the chat's next run. Only the person's switch here (or their click on an
 * agent's card) changes it; the host keeps it.
 */
function DontWaitRow({ threadId }: { threadId: string }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(true);
  const id = useId();
  useEffect(() => {
    let open = true;
    // Through a promise, so a window without the call (an older preload) leaves the switch off, never broken.
    void Promise.resolve()
      .then(() => window.studio.dontWaitState(threadId))
      .then(
        (state) => open && setOn(state.on),
        () => undefined,
      )
      .finally(() => open && setBusy(false));
    return () => {
      open = false;
    };
  }, [threadId]);
  const toggle = (next: boolean) => {
    setBusy(true);
    void Promise.resolve()
      .then(() => window.studio.setDontWait(threadId, next))
      .then(
        (state) => setOn(state.on),
        () => undefined,
      )
      .finally(() => setBusy(false));
  };
  const described = `${id}-description`;
  return (
    <div className={pickerItem} data-dont-wait-row>
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch">
        <span className="shrink-0">{DONT_WAIT_WORDS.label}</span>
        <span id={described} className="picker-desc" title={DONT_WAIT_WORDS.description}>
          {DONT_WAIT_WORDS.description}
        </span>
      </label>
      <PickerSwitch
        id={id}
        checked={on}
        disabled={busy}
        label={DONT_WAIT_WORDS.label}
        describedBy={described}
        onChange={toggle}
      />
    </div>
  );
}

/**
 * One Loop control: Off, until the build passes, a preset or a custom time. Without `onChange` the
 * Loop is shown, not changed (a build already owns it). With `loopUnavailable` (an Unreal game
 * until the Unreal Loop exists) it shows Off, offers Off alone and says why. Plan mode lives in
 * Add (`ComposerAddMenu`). With `dontWaitThread`, while the Loop is on, it also holds the chat's
 * "Don't wait for me" switch.
 */
export function ComposerModeMenu({
  value,
  onChange,
  disabled,
  loopUnavailable = false,
  unavailableWhy,
  dontWaitThread,
}: {
  value: LoopSetting;
  onChange?: (next: LoopSetting) => void;
  disabled?: boolean;
  loopUnavailable?: boolean;
  /** Why there is no Loop, when the game can say (its project and where it is). */
  unavailableWhy?: string;
  /** The game chat whose "Don't wait for me" the menu switches while the Loop is on. */
  dontWaitThread?: string;
}) {
  const { on: loopOn, hours } = value;
  const timed = hours !== null;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const choice = loopChoice(loopOn, hours, custom);
  const minutes = timed ? Math.round(hours * MINUTES_PER_HOUR) : null;
  // One setting per pick: two setters in a row would lose the first to a stale closure.
  const pick = (next: Choice) => {
    // Off is already the Loop shown, and a pick would overwrite the one the chat keeps for later.
    if (loopUnavailable) return;
    setDraft(null);
    setCustom(next === LoopChoice.Custom);
    onChange?.(chosenLoop(next, value));
  };
  const setMinutes = (minutesNow: number) => {
    setDraft(null);
    const clamped = Math.min(MAX_LOOP_MINUTES, Math.max(MIN_LOOP_MINUTES, minutesNow));
    onChange?.({ ...value, hours: clamped / MINUTES_PER_HOUR });
  };
  const commit = () => {
    if (draft === null) return;
    const parsed = parseDuration(draft);
    if (parsed !== null) setMinutes(parsed);
    else setDraft(null);
  };
  const { state, caption, label, time } = loopWords(loopOn, minutes);
  const customLimit = choice === LoopChoice.Custom ? minutes : null;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          const customHours = loopOn && timed && !PRESETS.includes(hours);
          setCustom(customHours);
          setDraft(null);
        }
      }}
    >
      <PopoverTrigger
        render={<button type="button" />}
        aria-label="Mode"
        disabled={disabled}
        className="composer-text-button composer-mode shrink-0"
        data-announce
      >
        {/* ∞ mounts as it is picked, so it draws itself once (data-announce); a limit leads with its time.
            Either gives way when the model's name needs the room (`toolbar-fit.ts`). */}
        {loopOn && !timed && <Icon name="infinity" className="composer-mode-limit" />}
        {time && (
          <>
            <span className="composer-mode-time composer-mode-limit">{time}</span>{" "}
          </>
        )}
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="picker-panel mode-panel w-[376px] max-w-(--available-width) p-1.5"
        aria-label="Mode options"
      >
        <div className={pickerItem}>
          <span className="flex-1">Loop mode</span>
          <span className="text-[12px] leading-4 text-ink-3">{state}</span>
        </div>
        <div className="px-1 pb-1">
          {onChange && (
            <PickerSegmented<Choice>
              label="Loop time limit"
              value={choice}
              onChange={pick}
              options={loopOptions(loopUnavailable)}
            />
          )}
          {onChange && customLimit !== null && (
            <CustomLimit
              minutes={customLimit}
              draft={draft}
              onDraft={setDraft}
              onCommit={commit}
              onMinutes={setMinutes}
            />
          )}
          <PickerCaption>
            {loopUnavailable ? (unavailableWhy ?? UNREAL_WORDS.loopUnavailable(null, "")) : caption}
          </PickerCaption>
        </div>
        {loopOn && !loopUnavailable && dontWaitThread && (
          <>
            <PickerSeparator />
            <DontWaitRow threadId={dontWaitThread} />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
