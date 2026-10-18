import { useEffect, useState, type JSX } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { nativeJobDisclosure } from "../../../shared/native-job-disclosure.ts";
import { NativeJobState, type PluginManifest, type PluginNativeResult } from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { Section } from "./rows.tsx";

const JOB_POLL_MS = 2 * SECOND_MS;
const MESSAGE = {
  title: "Background jobs",
  permission: "Agents can start background jobs. Cancel a running job here.",
  cancel: "Cancel",
  cancelling: "Cancelling…",
  status: {
    [NativeJobState.Running]: "Running",
    [NativeJobState.Completed]: "Completed",
    [NativeJobState.Cancelled]: "Cancelled",
    [NativeJobState.Failed]: "Failed",
    [NativeJobState.Interrupted]: "Interrupted",
  },
};

/** Host-owned time/GPU disclosure, shown even while the plugin is off. */
export function NativeJobLimits({ manifest }: { manifest: PluginManifest }): JSX.Element | null {
  const lines = nativeJobDisclosure(manifest);
  if (!lines.length) return null;
  return (
    <Section title={MESSAGE.title}>
      <div data-native-job-limits className="space-y-1 text-sm text-ink-3">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>{MESSAGE.permission}</p>
      </div>
    </Section>
  );
}

function elapsed(job: PluginNativeResult): string {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - Date.parse(job.createdAt)) / SECOND_MS));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Durable native jobs, drawn by the host so cancellation does not depend on plugin code. */
export function NativeJobs({ id }: { id: string }): JSX.Element | null {
  const [jobs, setJobs] = useState<PluginNativeResult[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await window.studio.pluginNativeJobs(id);
        if (alive) {
          setJobs(next);
          setError("");
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        reading = false;
      }
    };
    setJobs([]);
    setError("");
    setPending([]);
    void refresh();
    const timer = window.setInterval(() => void refresh(), JOB_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id]);
  const cancel = async (job: PluginNativeResult) => {
    setPending((ids) => [...ids, job.id]);
    try {
      await window.studio.pluginCancelNativeJob(id, job.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending((ids) => ids.filter((value) => value !== job.id));
    }
  };
  if (!jobs.length && !error) return null;
  return (
    <div className="space-y-2" data-native-jobs>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {[...jobs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((job) => (
          <div className="genex-account genex-account-row" key={job.id} data-native-job={job.id}>
            <div className="genex-account-copy">
              <h3 className="text-sm font-medium">{job.recipe}</h3>
              <p>
                {job.project} · {MESSAGE.status[job.state]} · <span data-native-job-elapsed>{elapsed(job)}</span>
              </p>
              {job.reason && job.state !== NativeJobState.Completed && (
                <p className="text-sm text-ink-3">{job.reason}</p>
              )}
            </div>
            {job.state === NativeJobState.Running && (
              <Button
                disabled={pending.includes(job.id)}
                aria-label={`Cancel ${job.recipe}`}
                onClick={() => void cancel(job)}
              >
                {pending.includes(job.id) ? MESSAGE.cancelling : MESSAGE.cancel}
              </Button>
            )}
          </div>
        ))}
    </div>
  );
}
