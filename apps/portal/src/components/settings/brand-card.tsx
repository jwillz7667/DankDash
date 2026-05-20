'use client';

/**
 * Brand card: hex color + logo/hero R2 object keys. The image keys
 * are edited as raw strings here — Phase 16 will wire a presigned-URL
 * upload flow that mutates these for the operator. For now the
 * authoritative source of new logos is whoever uploads to R2; this
 * surface only records the key so the menu/web can resolve it.
 *
 * The hex color preview is a 32px swatch next to the input so the
 * operator can see what they typed before they save.
 */
import { Loader2, Palette } from 'lucide-react';
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

export interface BrandCardProps {
  readonly brandColorHex: string | null;
  readonly logoImageKey: string | null;
  readonly heroImageKey: string | null;
  readonly onPatch: VendorSettingsActions['patch'];
  readonly onPatched: (settings: VendorSettings) => void;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/u;

export function BrandCard({
  brandColorHex,
  logoImageKey,
  heroImageKey,
  onPatch,
  onPatched,
}: BrandCardProps): ReactNode {
  const [color, setColor] = useState(brandColorHex ?? '');
  const [logo, setLogo] = useState(logoImageKey ?? '');
  const [hero, setHero] = useState(heroImageKey ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const colorId = useId();
  const logoId = useId();
  const heroId = useId();

  useEffect(() => {
    setColor(brandColorHex ?? '');
    setLogo(logoImageKey ?? '');
    setHero(heroImageKey ?? '');
  }, [brandColorHex, logoImageKey, heroImageKey]);

  const swatchValid = HEX_RE.test(color);

  const dirty = useMemo(() => {
    const cNorm = color.trim() === '' ? null : color.trim();
    const lNorm = logo.trim() === '' ? null : logo.trim();
    const hNorm = hero.trim() === '' ? null : hero.trim();
    return cNorm !== brandColorHex || lNorm !== logoImageKey || hNorm !== heroImageKey;
  }, [color, logo, hero, brandColorHex, logoImageKey, heroImageKey]);

  const handleSubmit = useCallback(
    async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setError(null);
      setSuccess(null);
      const cNorm = color.trim() === '' ? null : color.trim();
      const lNorm = logo.trim() === '' ? null : logo.trim();
      const hNorm = hero.trim() === '' ? null : hero.trim();
      if (cNorm !== null && !HEX_RE.test(cNorm)) {
        setError('Brand color must be #RRGGBB.');
        return;
      }
      setBusy(true);
      try {
        const updated = await onPatch({
          brandColorHex: cNorm,
          logoImageKey: lNorm,
          heroImageKey: hNorm,
        });
        onPatched(updated);
        setSuccess('Brand saved.');
      } catch (err) {
        setError(extractError(err));
      } finally {
        setBusy(false);
      }
    },
    [color, logo, hero, onPatch, onPatched],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-moss-50 text-moss-700">
            <Palette aria-hidden="true" className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Brand</CardTitle>
            <CardSubtitle>
              The color and assets the consumer app uses for your storefront.
            </CardSubtitle>
          </div>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor={colorId}>Brand color (hex)</Label>
              <Input
                id={colorId}
                type="text"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                }}
                placeholder="#1A4314"
                disabled={busy}
                aria-invalid={color !== '' && !swatchValid ? 'true' : undefined}
              />
            </div>
            <div
              aria-hidden="true"
              className="h-10 w-10 rounded-lg border border-slate-200"
              style={
                swatchValid
                  ? { backgroundColor: color }
                  : {
                      background:
                        'repeating-linear-gradient(45deg, #f1f5f9 0 6px, #e2e8f0 6px 12px)',
                    }
              }
              data-testid="brand-color-swatch"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={logoId}>Logo image key</Label>
              <Input
                id={logoId}
                type="text"
                value={logo}
                onChange={(e) => {
                  setLogo(e.target.value);
                }}
                placeholder="dispensaries/<id>/logo.png"
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={heroId}>Hero image key</Label>
              <Input
                id={heroId}
                type="text"
                value={hero}
                onChange={(e) => {
                  setHero(e.target.value);
                }}
                placeholder="dispensaries/<id>/hero.jpg"
                disabled={busy}
              />
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Image keys reference the asset's path in our object store. Upload UI ships in Phase 16;
            until then, paste the key your account manager provides.
          </p>

          <div className="flex items-center justify-between gap-3">
            <div className="min-h-[1.25rem]">
              {error !== null ? (
                <p role="alert" className="text-sm font-medium text-rose-700">
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
                'Save brand'
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
      return err.envelope?.error.message ?? 'That brand input was rejected.';
    }
    if (err.status === 403) return "You don't have permission to update brand assets.";
  }
  return "Couldn't save. Try again.";
}
