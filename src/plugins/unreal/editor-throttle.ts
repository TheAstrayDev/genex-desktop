/**
 * Unreal's "Use Less CPU when in Background" (`bThrottleCPUWhenNotForeground`): while it is on, an
 * editor behind Genex plays at a few frames per second, so a play test measures a slow game. The
 * bridge and the Unreal Loop's editor queue read and write it through Epic's ObjectTools on the
 * settings' class default object, which changes the running editor and never its saved config.
 */

/** Epic's toolset that reads and writes an object's properties. */
export const OBJECT_TOOLSET = "editor_toolset.toolsets.object.ObjectTools";

/** Epic's ObjectTools tools that read and write the throttle, by their wire names. */
export const ObjectTool = { GetProperties: "get_properties", SetProperties: "set_properties" } as const;
export type ObjectTool = (typeof ObjectTool)[keyof typeof ObjectTool];

/** The editor's performance settings, as their class default object, and the throttle's property. */
const SETTINGS = "/Script/UnrealEd.Default__EditorPerformanceSettings";
const PROPERTY = "bThrottleCPUWhenNotForeground";

/** The arguments of a `get_properties` call that reads the throttle. */
export const readThrottleArgs = (): Record<string, unknown> => ({ instance: SETTINGS, properties: [PROPERTY] });

/** The arguments of a `set_properties` call that turns the throttle on or off (Epic takes the values as JSON text). */
export const writeThrottleArgs = (on: boolean): Record<string, unknown> => ({
  instance: SETTINGS,
  values: JSON.stringify({ [PROPERTY]: on }),
});

/** The values a `get_properties` answer holds: Epic answers JSON text, which a caller may have parsed already. */
function answerValues(answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(answer);
  } catch {
    return undefined;
  }
}

/** The throttle's value in a `get_properties` answer; undefined when the answer holds none. */
export function throttleIn(answer: unknown): boolean | undefined {
  const values = answerValues(answer);
  if (!values || typeof values !== "object") return undefined;
  const value = (values as Record<string, unknown>)[PROPERTY];
  return typeof value === "boolean" ? value : undefined;
}

/** Whether a `set_properties` answer says the editor took the values. */
export const tookValues = (answer: unknown): boolean => answer === true;
