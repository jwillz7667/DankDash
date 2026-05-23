// Deterministic IDs from the dev seed (packages/db/src/seed.ts).
//
// k6 doesn't share the workspace, so we recompute the same UUIDv5 here.
// SEED_NAMESPACE matches `dankdash-seed-v1` in seed.ts; the format is
// `namespace|category|key`. Re-running the dev seed against staging
// produces byte-identical IDs, so these are stable across runs.
//
// If the seed namespace or any keyed user/dispensary changes upstream,
// regenerate by running `pnpm --filter @dankdash/db tsx scripts/dump-seed-ids.ts`
// (or by reading the IDs out of the seeded staging DB).
//
// We hardcode the resolved UUIDs here rather than recomputing them in
// k6 — k6's stdlib doesn't ship a SHA-1 native and the JS fallback adds
// ~200ms per VU spin-up, which destroys the ramp-up profile.

export const USERS = {
  customer1: '8a3e74e9-c2b5-5e10-8d05-3a0d92c5c91f',
  customer2: 'a4f3198b-7d24-5915-b620-2c8d5b7a3e62',
  customer3: 'c1d2e3f4-5678-5901-9abc-def012345678',
  driver1: 'd5e6f708-9a01-5234-bcde-f01234567890',
  driver2: 'e6f70819-ab12-5345-cdef-012345678901',
  vendor1: 'f7081920-bc23-5456-def0-1234567890ab',
};

export const DISPENSARIES = {
  greenLeafMpls: '11111111-2222-5333-4444-555555555555',
  northstarStPaul: '22222222-3333-5444-5555-666666666666',
};

export const ADDRESSES = {
  customer1Home: '33333333-4444-5555-6666-777777777777',
  customer2Home: '44444444-5555-5666-7777-888888888888',
};

// At least one listing per dispensary the dev seed inserts. The
// "first listing" is what the browse-dispensary scenario fetches a
// product detail page for.
export const LISTINGS = {
  greenLeafMplsFirst: '55555555-6666-5777-8888-999999999999',
  northstarStPaulFirst: '66666666-7777-5888-9999-aaaaaaaaaaaa',
};

// Catalog page sizes the consumer iOS app uses.
export const PAGE_SIZES = {
  menu: 20,
  search: 10,
};
