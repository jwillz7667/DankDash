'use client';

/**
 * Weekly hours editor. Seven rows, one per day, each with an
 * open/close pair plus a "Closed" toggle. Hours are batched — the
 * "Save hours" button writes the whole `DispensaryHours` object in
 * one PATCH so the table can never end up in a half-saved state.
 *
 * Open/close fields accept HH:MM, validated client-side via
 * `isValidHhMm` (matches the server schema's 00:00 – 30:00 range so
 * a "close at 02:00 the next day" stored as "26:00" is permitted by
 * the wire format). The server is authoritative; client validation
 * is a UX guard.
 *
 * `hoursEqual` decides whether to issue a save at all — if nothing
 * changed, the Save button stays disabled.
 */
import { Clock, Loader2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { ApiError } from '../../lib/api/client.js';
import { DAYS, hoursEqual, isValidHhMm } from '../../lib/settings/format.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';
import type { DispensaryHours, VendorSettings } from '../../lib/api/vendor-settings.js';
import type { VendorSettingsActions } from '../../lib/settings/settings-actions.js';

export interface HoursEditorProps {
  readonly hours: DispensaryHours;
  readonly onPatch: VendorSettingsActions['patch'];
  readonly onPatched: (settings: VendorSettings) => void;
}

interface DraftDay {
  readonly open: string;
  readonly close: string;
  readonly closed: boolean;
}

type Draft = Record<keyof DispensaryHours, DraftDay>;

function toDraft(hours: DispensaryHours): Draft {
  const out: Partial<Draft> = {};
  for (const def of DAYS) {
    const v = hours[def.key];
    if (v === null) {
      out[def.key] = { open: '08:00', close: '22:00', closed: true };
    } else {
      out[def.key] = { open: v.open, close: v.close, closed: false };
    }
  }
  return out as Draft;
}

function fromDraft(draft: Draft): DispensaryHours {
  return {
    mon: draft.mon.closed ? null : { open: draft.mon.open, close: draft.mon.close },
    tue: draft.tue.closed ? null : { open: draft.tue.open, close: draft.tue.close },
    wed: draft.wed.closed ? null : { open: draft.wed.open, close: draft.wed.close },
    thu: draft.thu.closed ? null : { open: draft.thu.open, close: draft.thu.close },
    fri: draft.fri.closed ? null : { open: draft.fri.open, close: draft.fri.close },
    sat: draft.sat.closed ? null : { open: draft.sat.open, close: draft.sat.close },
    sun: draft.sun.closed ? null : { open: draft.sun.open, close: draft.sun.close },
  };
}

function validateDraft(draft: Draft): string | null {
  for (const def of DAYS) {
    const d = draft[def.key];
    if (d.closed) continue;
    if (!isValidHhMm(d.open) || !isValidHhMm(d.close)) {
      return `${def.label}: use HH:MM (24-hour).`;
    }
  }
  return null;
}

export function HoursEditor({ hours, onPatch, onPatched }: HoursEditorProps): ReactNode {
  const [draft, setDraft] = useState<Draft>(() => toDraft(hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const baseId = useId();

  // Re-seed the draft when the server snapshot changes (e.g. another
  // tab just patched). Editing a stale field is worse than dropping
  // an in-flight tweak.
  useEffect(() => {
    setDraft(toDraft(hours));
  }, [hours]);

  const dirty = useMemo(() => !hoursEqual(hours, fromDraft(draft)), [hours, draft]);

  const updateDay = useCallback((key: keyof DispensaryHours, patch: Partial<DraftDay>): void => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setSuccess(null);
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    setError(null);
    setSuccess(null);
    const validation = validateDraft(draft);
    if (validation !== null) {
      setError(validation);
      return;
    }
    setBusy(true);
    try {
      const updated = await onPatch({ hours: fromDraft(draft) });
      onPatched(updated);
      setSuccess('Hours saved.');
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }, [draft, onPatch, onPatched]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-moss-50 text-moss-700">
            <Clock aria-hidden="true" className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Store hours</CardTitle>
            <CardSubtitle>
              Times use a 24-hour clock. Use 25:00 – 30:00 for a close that runs past midnight.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <table className="w-full text-left text-sm" data-testid="hours-table">
          <thead className="sr-only">
            <tr>
              <th>Day</th>
              <th>Open</th>
              <th>Close</th>
              <th>Closed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {DAYS.map((def) => {
              const d = draft[def.key];
              const openId = `${baseId}-${def.key}-open`;
              const closeId = `${baseId}-${def.key}-close`;
              const closedId = `${baseId}-${def.key}-closed`;
              return (
                <tr key={def.key} data-day={def.key}>
                  <td className="w-32 py-2 text-sm font-medium text-slate-700">{def.label}</td>
                  <td className="px-2 py-2">
                    <label htmlFor={openId} className="sr-only">
                      {def.label} open time
                    </label>
                    <input
                      id={openId}
                      type="text"
                      inputMode="numeric"
                      placeholder="08:00"
                      value={d.open}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        updateDay(def.key, { open: e.target.value });
                      }}
                      disabled={d.closed || busy}
                      className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-moss-500 focus:outline-none focus:ring-2 focus:ring-moss-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <label htmlFor={closeId} className="sr-only">
                      {def.label} close time
                    </label>
                    <input
                      id={closeId}
                      type="text"
                      inputMode="numeric"
                      placeholder="22:00"
                      value={d.close}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        updateDay(def.key, { close: e.target.value });
                      }}
                      disabled={d.closed || busy}
                      className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-moss-500 focus:outline-none focus:ring-2 focus:ring-moss-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <label
                      htmlFor={closedId}
                      className="inline-flex items-center gap-2 text-sm text-slate-600"
                    >
                      <input
                        id={closedId}
                        type="checkbox"
                        checked={d.closed}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          updateDay(def.key, { closed: e.target.checked });
                        }}
                        disabled={busy}
                        className="h-4 w-4 rounded border-slate-300 text-moss-500 focus:ring-moss-500"
                      />
                      Closed
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div>
            {error !== null ? (
              <p role="alert" className="text-sm font-medium text-rose-700">
                {error}
              </p>
            ) : success !== null ? (
              <p role="status" className="text-sm font-medium text-moss-700">
                {success}
              </p>
            ) : (
              <p className="text-sm text-slate-500">
                {dirty ? 'You have unsaved changes.' : "Hours match what's saved."}
              </p>
            )}
          </div>
          <Button
            onClick={() => {
              void handleSave();
            }}
            disabled={!dirty || busy}
          >
            {busy ? (
              <>
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save hours'
            )}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) {
      return err.envelope?.error.message ?? 'The hours format was rejected.';
    }
    if (err.status === 403) return "You don't have permission to change hours.";
  }
  return "Couldn't save hours. Try again.";
}
