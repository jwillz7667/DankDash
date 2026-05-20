import { type ReactNode } from 'react';
import { Badge } from '../ui/badge.js';
import { Card, CardBody } from '../ui/card.js';

export interface PagePlaceholderProps {
  readonly title: string;
  readonly description: string;
  readonly phase: string;
  readonly children?: ReactNode;
}

/**
 * Visual placeholder used by Phase 13 route scaffolds. Pages are
 * filled in by later phases (orders queue in 14, menu in 15, etc.);
 * keeping a consistent shell now means each follow-up phase only has
 * to replace the body, not re-establish layout chrome.
 */
export function PagePlaceholder({
  title,
  description,
  phase,
  children,
}: PagePlaceholderProps): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="max-w-2xl text-sm text-slate-500">{description}</p>
        </div>
        <Badge tone="accent">Ships in {phase}</Badge>
      </header>
      <Card>
        <CardBody className="space-y-3 px-10 py-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-moss-50 text-moss-700">
            <span aria-hidden="true" className="text-xl">
              ∎
            </span>
          </div>
          <h2 className="text-base font-semibold tracking-tight text-slate-900">Coming soon</h2>
          <div className="mx-auto max-w-md text-sm leading-relaxed text-slate-500">
            {children ?? (
              <p>
                This surface lands in {phase}. Phase 13 stands up the auth shell, navigation, and
                realtime plumbing so subsequent phases can plug their UI in without re-doing the
                chrome.
              </p>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
