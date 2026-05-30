'use client';

/**
 * Editable contact card: phone + email. Both are optional (nullable),
 * which is why the form uses an empty string as the "cleared" state
 * and sends `null` over the wire when blank.
 */
import { Loader2, Mail, Phone } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { ApiError } from '../../lib/api/client.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import type { VendorSettings } from '../../lib/api/vendor-settings.js';
import type { VendorSettingsActions } from '../../lib/settings/settings-actions.js';

export interface ContactCardProps {
  readonly phone: string | null;
  readonly email: string | null;
  readonly onPatch: VendorSettingsActions['patch'];
  readonly onPatched: (settings: VendorSettings) => void;
}

export function ContactCard({ phone, email, onPatch, onPatched }: ContactCardProps): ReactNode {
  const [phoneInput, setPhoneInput] = useState(phone ?? '');
  const [emailInput, setEmailInput] = useState(email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const phoneId = useId();
  const emailId = useId();

  useEffect(() => {
    setPhoneInput(phone ?? '');
    setEmailInput(email ?? '');
  }, [phone, email]);

  const dirty = useMemo(() => {
    const pNorm = phoneInput.trim() === '' ? null : phoneInput.trim();
    const eNorm = emailInput.trim() === '' ? null : emailInput.trim();
    return pNorm !== phone || eNorm !== email;
  }, [phone, email, phoneInput, emailInput]);

  const handleSubmit = useCallback(
    async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setError(null);
      setSuccess(null);
      setBusy(true);
      const pNorm = phoneInput.trim() === '' ? null : phoneInput.trim();
      const eNorm = emailInput.trim() === '' ? null : emailInput.trim();
      try {
        const updated = await onPatch({ phone: pNorm, email: eNorm });
        onPatched(updated);
        setSuccess('Contact info saved.');
      } catch (err) {
        setError(extractError(err));
      } finally {
        setBusy(false);
      }
    },
    [phoneInput, emailInput, onPatch, onPatched],
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Contact</CardTitle>
          <CardSubtitle>
            Used on receipts and customer notifications. Both fields are optional.
          </CardSubtitle>
        </div>
      </CardHeader>
      <CardBody>
        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="space-y-4"
          noValidate
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={phoneId}>Phone</Label>
              <div className="relative">
                <Phone
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                />
                <Input
                  id={phoneId}
                  type="tel"
                  autoComplete="tel"
                  value={phoneInput}
                  onChange={(e) => {
                    setPhoneInput(e.target.value);
                  }}
                  placeholder="+1 (612) 555-0100"
                  disabled={busy}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <div className="relative">
                <Mail
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                />
                <Input
                  id={emailId}
                  type="email"
                  autoComplete="email"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                  }}
                  placeholder="hello@store.com"
                  disabled={busy}
                  className="pl-9"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-h-[1.25rem]">
              {error !== null ? (
                <p role="alert" className="text-sm font-medium text-danger">
                  {error}
                </p>
              ) : success !== null ? (
                <p role="status" className="text-sm font-medium text-moss-700">
                  {success}
                </p>
              ) : null}
            </div>
            <Button type="submit" disabled={!dirty || busy}>
              {busy ? (
                <>
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save contact'
              )}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) {
      return err.envelope?.error.message ?? 'Phone or email format was rejected.';
    }
    if (err.status === 403) return "You don't have permission to update contact info.";
  }
  return "Couldn't save. Try again.";
}
