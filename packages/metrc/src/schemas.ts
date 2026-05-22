/**
 * Zod schemas for Metrc REST responses.
 *
 * Every Metrc response crosses the schema before any property access —
 * upstream shape drift (Metrc has rolled out incremental field additions
 * historically) is then a structured `ExternalServiceError` rather than a
 * `TypeError: cannot read .Id of undefined` cascading into the worker
 * orchestration.
 *
 * `.passthrough()` keeps non-breaking field additions safe; we only
 * validate the fields the adapter actually consumes.
 */
import { z } from 'zod';

const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'invalid ISO date-time',
});

const unitOfMeasureSchema = z.enum([
  'Grams',
  'Ounces',
  'Pounds',
  'Milligrams',
  'Kilograms',
  'Each',
]);

const salesCustomerTypeSchema = z.enum(['Consumer', 'Patient', 'Caregiver', 'ExternalPatient']);

/**
 * Element of the array returned by `GET /sales/v2/receipts/active` and
 * `GET /sales/v2/receipts/{id}`. Metrc emits decimal numerics as JSON
 * numbers; we accept either number or numeric string and re-emit as
 * strings so the caller never has to think about float precision.
 */
const decimalString = z
  .union([z.number().finite(), z.string()])
  .transform((value) => (typeof value === 'number' ? value.toString() : value));

const receiptTransactionSchema = z
  .object({
    PackageId: z.number().int().nonnegative(),
    PackageLabel: z.string().min(1),
    ProductName: z.string().min(1),
    Quantity: decimalString,
    UnitOfMeasure: unitOfMeasureSchema,
    TotalPrice: decimalString,
  })
  .passthrough();

export const ReceiptResponseSchema = z
  .object({
    Id: z.number().int().nonnegative(),
    ReceiptNumber: z.string().min(1),
    SalesDateTime: isoDateTime,
    SalesCustomerType: salesCustomerTypeSchema,
    TotalPackages: z.number().int().nonnegative(),
    TotalPrice: decimalString,
    Transactions: z.array(receiptTransactionSchema),
    LastModified: isoDateTime,
  })
  .passthrough();

export const ReceiptListResponseSchema = z.array(ReceiptResponseSchema);

export type ReceiptResponse = z.infer<typeof ReceiptResponseSchema>;
