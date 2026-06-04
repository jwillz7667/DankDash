import {
  ArrowUpRight,
  CheckCircle2,
  Clock,
  DollarSign,
  Leaf,
  PackageCheck,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { Badge } from '../../../components/ui/badge.js';
import {
  Card,
  CardBody,
  CardHeader,
  CardSubtitle,
  CardTitle,
} from '../../../components/ui/card.js';
import { StatCard } from '../../../components/ui/stat-card.js';

export const metadata: Metadata = {
  title: 'Dashboard — DankDash for Business',
};

/**
 * Dashboard preview. The KPIs and order rail wire up to live data in
 * Phase 17; the numbers below are presentational so the visual
 * system can be reviewed against real proportions, copy lengths and
 * hierarchy. No "lorem ipsum"-style content — every value reads like
 * something a dispensary owner would actually see.
 */
export default function DashboardPage(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-moss-600">Today</p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Good morning, North Loop
          </h1>
          <p className="text-sm text-muted">
            Live metrics will update in real-time once the analytics service ships in Phase 17.
          </p>
        </div>
        <Badge tone="accent" icon={<ShieldCheck className="h-3 w-3" />}>
          Compliance checks passing
        </Badge>
      </header>

      <section
        aria-label="Key performance indicators"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatCard
          label="Revenue"
          value="$12,486"
          delta="+8.2% vs yesterday"
          trend="up"
          icon={<DollarSign className="h-4 w-4" />}
          highlight
        />
        <StatCard
          label="Orders in flight"
          value="14"
          suffix="of 47 today"
          icon={<PackageCheck className="h-4 w-4" />}
        />
        <StatCard
          label="Avg basket"
          value="$73.40"
          delta="+$2.18 vs last week"
          trend="up"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          label="ID-scan pass rate"
          value="99.4%"
          delta="—"
          trend="flat"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="space-y-0.5">
              <CardTitle>Recent activity</CardTitle>
              <CardSubtitle>Last 12 minutes — live in Phase 17.</CardSubtitle>
            </div>
            <Badge tone="info" icon={<Clock className="h-3 w-3" />}>
              Preview
            </Badge>
          </CardHeader>
          <ul className="divide-y divide-outline-subtle">
            {ACTIVITY.map((row) => (
              <li key={row.id} className="flex items-start gap-4 px-6 py-4">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-moss-50 text-moss-700"
                >
                  <row.icon className="h-4 w-4" />
                </span>
                <div className="flex-1 space-y-0.5">
                  <p className="text-sm font-medium text-foreground">{row.title}</p>
                  <p className="text-xs text-muted">{row.detail}</p>
                </div>
                <div className="flex flex-col items-end gap-1 font-tabular">
                  <span className="text-sm font-medium text-foreground">{row.amount}</span>
                  <span className="text-2xs text-muted">{row.at}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader>
            <div className="space-y-0.5">
              <CardTitle>Today's checklist</CardTitle>
              <CardSubtitle>Compliance + ops, server-verified.</CardSubtitle>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            {CHECKLIST.map((item) => (
              <div key={item.id} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={
                    item.done
                      ? 'mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-moss-500 text-on-primary'
                      : 'mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-outline bg-surface'
                  }
                >
                  {item.done ? <CheckCircle2 className="h-3 w-3" /> : null}
                </span>
                <div className="flex-1 space-y-0.5">
                  <p
                    className={
                      item.done ? 'text-sm text-muted line-through' : 'text-sm text-foreground'
                    }
                  >
                    {item.title}
                  </p>
                  <p className="text-xs text-muted">{item.detail}</p>
                </div>
              </div>
            ))}
            <div className="rounded-xl border border-moss-100 bg-moss-50 p-4">
              <div className="flex items-center gap-2 text-moss-800">
                <Leaf className="h-4 w-4" />
                <p className="text-sm font-medium">Catalog within MN limits</p>
              </div>
              <p className="mt-1 text-xs text-moss-700">
                All 142 listings re-checked at 8:00 AM CT against Minn. Stat. § 342.27.
              </p>
              <a
                href="/settings/compliance"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-moss-700 hover:text-moss-800"
              >
                View report
                <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
              </a>
            </div>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}

const ACTIVITY = [
  {
    id: 'ord_8421',
    icon: PackageCheck,
    title: 'Order #8421 delivered',
    detail: 'Driver Sam · 2.1 mi · 24 min total',
    amount: '$82.40',
    at: '2 min ago',
  },
  {
    id: 'ord_8420',
    icon: Leaf,
    title: 'New order from Mia R.',
    detail: 'Sunset OG 3.5g · Live Resin Vape · 1 more',
    amount: '$108.00',
    at: '4 min ago',
  },
  {
    id: 'ord_8419',
    icon: ShieldCheck,
    title: 'ID scan verified',
    detail: 'Order #8419 · 26 y/o · MN ID',
    amount: '—',
    at: '7 min ago',
  },
  {
    id: 'ord_8418',
    icon: PackageCheck,
    title: 'Order #8418 picked up',
    detail: 'Driver Avery · ETA 8 min',
    amount: '$54.20',
    at: '11 min ago',
  },
] as const;

const CHECKLIST = [
  {
    id: 'open-til',
    title: 'Open till — North Loop',
    detail: 'Opened 8:03 AM by Avery Stone',
    done: true,
  },
  {
    id: 'coa-fresh',
    title: 'COAs current for all listed batches',
    detail: 'Last sync: 7:58 AM',
    done: true,
  },
  {
    id: 'driver-checkin',
    title: 'Driver check-ins',
    detail: '3 of 4 on shift — Jamie expected 10:30 AM',
    done: false,
  },
] as const;
