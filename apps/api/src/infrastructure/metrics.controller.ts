/**
 * Prometheus scrape endpoint.
 *
 * Returns the registry contents in the Prom 0.0.4 text-exposition
 * format. The controller is bound at the app's root (no /v1 prefix)
 * because Prometheus scrape configs don't follow versioned paths.
 *
 * Access posture: the route is loopback-only by default. Production
 * scrapes happen from within Railway's internal network — the
 * Prometheus container reaches the api via its private hostname and
 * exits the request from a private IP (10.0.0.0/8 / 172.16.0.0/12 /
 * 192.168.0.0/16) or the wildcard runtime IP `100.64.0.0/10` that
 * Railway uses for internal mesh. We accept any of those, plus the
 * loopback CIDRs for local dev. Anything from the public internet
 * gets 404 (not 403 — we don't want to advertise the endpoint's
 * existence). The endpoint is @Public so the global JwtAuthGuard
 * doesn't intercept it; access control is the IP check below.
 *
 * For ad-hoc operator scraping from outside the cluster, use the
 * `superadmin`-gated wrapper in the admin module (Phase 22).
 */
import { Controller, Get, Inject, NotFoundException, Req, Res } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import { METRICS_REGISTRY } from './observability.module.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Registry } from 'prom-client';

// Source: https://datatracker.ietf.org/doc/html/rfc1918 + RFC 6598
// (carrier-grade NAT, which Railway uses for its mesh) + IPv4/IPv6
// loopback. Ordered most-restrictive first so the common case (mesh
// scrape) returns true on the first comparison.
const ALLOWED_PREFIXES_V4: readonly string[] = [
  '10.',
  '127.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '100.64.',
  '100.65.',
  '100.66.',
  '100.67.',
  '100.68.',
  '100.69.',
  '100.70.',
  '100.71.',
  '100.72.',
  '100.73.',
  '100.74.',
  '100.75.',
  '100.76.',
  '100.77.',
  '100.78.',
  '100.79.',
];

function isInternalIp(ip: string | undefined): boolean {
  if (ip === undefined || ip.length === 0) return false;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  // ::ffff:X.X.X.X is the IPv4-mapped IPv6 form Node uses behind a
  // dual-stack listener. Strip the prefix before checking.
  const candidate = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (candidate.startsWith('fc') || candidate.startsWith('fd')) return true;
  return ALLOWED_PREFIXES_V4.some((prefix) => candidate.startsWith(prefix));
}

@Controller()
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Public()
  @Get('metrics')
  async metrics(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    if (!isInternalIp(req.ip)) {
      // Fail closed; do not echo client IP in the 404 body.
      throw new NotFoundException('Not Found');
    }
    const body = await this.registry.metrics();
    void res.status(200).header('content-type', this.registry.contentType).send(body);
  }
}
